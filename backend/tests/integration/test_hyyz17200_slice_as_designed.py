"""Batch "slice as designed": library 3MFs sliced one at a time with their own settings."""

from __future__ import annotations

import asyncio
import inspect
import io
import json
import re
import zipfile

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.api.routes import library
from backend.app.core.config import settings as app_settings
from backend.app.hyyz17200 import slice_as_designed
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.settings import Settings as SettingsModel
from backend.app.services import slicer_api as slicer_api_module

URL = "/api/v1/hyyz17200/library/slice-as-designed"


def make_3mf(*, plates: int = 1, settings: bool = True, sliced: bool = False) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("3D/3dmodel.model", "<model/>")
        if settings:
            zf.writestr(
                "Metadata/project_settings.config",
                json.dumps({"printer_settings_id": "# My A1 swapper", "wall_loops": "5"}),
            )
        plate_xml = "".join(f'<plate><metadata key="plater_id" value="{n}"/></plate>' for n in range(1, plates + 1))
        zf.writestr("Metadata/model_settings.config", f"<config><object id='1'/>{plate_xml}</config>")
        if sliced:
            zf.writestr("Metadata/plate_1.gcode", "G28\n")
    return buf.getvalue()


def sliced_answer() -> httpx.Response:
    return httpx.Response(
        200,
        content=make_3mf(sliced=True),
        headers={"x-print-time-seconds": "60", "x-filament-used-g": "2.0", "x-filament-used-mm": "500"},
    )


def is_slice_post(request: httpx.Request) -> bool:
    return request.method == "POST" and request.url.path.endswith("/slice")


def plate_field(body: bytes) -> str | None:
    match = re.search(rb'name="plate"\r\n\r\n([^\r]*)', body)
    return match.group(1).decode() if match else None


class Sidecar:
    """A mock sidecar that records each slice and how many ran at once."""

    def __init__(self, delay: float = 0.0, fail_names: tuple[str, ...] = ()):
        self.delay = delay
        self.fail_names = fail_names
        self.bodies: list[bytes] = []
        self.running = 0
        self.most_at_once = 0
        self.release = asyncio.Event()
        self.release.set()

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        if not is_slice_post(request):
            return httpx.Response(404)
        body = request.content
        self.bodies.append(body)
        self.running += 1
        self.most_at_once = max(self.most_at_once, self.running)
        try:
            await self.release.wait()
            await asyncio.sleep(self.delay)
        finally:
            self.running -= 1
        if any(name.encode() in body for name in self.fail_names):
            return httpx.Response(500, json={"error": "Slicing failed", "details": "segfault"})
        return sliced_answer()


@pytest.fixture
async def library_dir(db_session, tmp_path, monkeypatch):
    storage = tmp_path / "library" / "files"
    storage.mkdir(parents=True)
    monkeypatch.setattr(app_settings, "base_dir", tmp_path)
    db_session.add(SettingsModel(key="preferred_slicer", value="bambu_studio"))
    await db_session.commit()
    slice_as_designed.reset_for_tests()
    yield storage
    slice_as_designed.reset_for_tests()
    slicer_api_module.set_shared_http_client(None)


def use_sidecar(sidecar: Sidecar) -> None:
    client = httpx.AsyncClient(transport=httpx.MockTransport(sidecar), timeout=10.0)
    slicer_api_module.set_shared_http_client(client)


async def add_file(db_session, storage, name: str, content: bytes, folder_id: int | None = None) -> int:
    path = storage / name
    path.write_bytes(content)
    row = LibraryFile(
        filename=name,
        file_path=str(path.relative_to(app_settings.base_dir)),
        file_type="3mf" if name.endswith(".3mf") else name.rsplit(".", 1)[-1],
        file_size=len(content),
        folder_id=folder_id,
    )
    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)
    return row.id


async def wait_finished(client: AsyncClient, batch_id: int, timeout: float = 10.0) -> dict:
    """Wait in-process, then read the batch over the API once.

    Not by polling the API: the test database is one shared in-memory SQLite
    connection, and every request's session closes with a ROLLBACK on it, which
    can land between a slice job's INSERT and its COMMIT and drop the new row.
    A real database gives each session its own connection."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        batch = next(b for b in slice_as_designed.list_batches(None) if b.id == batch_id)
        if batch.finished_at is not None:
            break
        await asyncio.sleep(0.05)
    else:
        raise AssertionError(f"batch {batch_id} did not finish")
    batches = (await client.get(URL)).json()
    return next(b for b in batches if b["id"] == batch_id)


def by_name(batch: dict) -> dict[str, dict]:
    return {item["name"]: item for item in batch["items"]}


@pytest.mark.asyncio
async def test_each_3mf_is_sliced_with_its_own_settings_into_its_folder(
    async_client: AsyncClient, db_session, library_dir
):
    folder = LibraryFolder(name="A1 jobs")
    db_session.add(folder)
    await db_session.commit()
    await db_session.refresh(folder)
    one = await add_file(db_session, library_dir, "one.3mf", make_3mf(), folder.id)
    two = await add_file(db_session, library_dir, "two.3mf", make_3mf(plates=3), folder.id)
    sidecar = Sidecar()
    use_sidecar(sidecar)

    started = await async_client.post(URL, json={"file_ids": [one, two]})

    assert started.status_code == 200, started.text
    batch = await wait_finished(async_client, started.json()["id"])
    items = by_name(batch)
    assert items["one.3mf"]["status"] == "done", items
    assert items["two.3mf"]["status"] == "done", items
    assert items["two.3mf"]["plate_count"] == 3

    assert len(sidecar.bodies) == 2
    for body in sidecar.bodies:
        # No --load-settings: the file's own project_settings.config drives the slice.
        assert b"printerProfile" not in body
        assert b"presetProfile" not in body
        assert b"filamentProfile" not in body
        # Layout untouched.
        assert b'name="arrange"' not in body or b'name="arrange"\r\n\r\n0' in body
    # One plate: that plate. Several: every plate into one file.
    assert [plate_field(b) for b in sidecar.bodies] == ["1", "0"]

    outputs = (await db_session.execute(select(LibraryFile).where(LibraryFile.source_type == "sliced"))).scalars().all()
    assert sorted(o.filename for o in outputs) == ["one.gcode.3mf", "two.gcode.3mf"]
    assert all(o.folder_id == folder.id for o in outputs)
    assert all(o.file_metadata.get("used_embedded_settings") for o in outputs)
    assert {items["one.3mf"]["output_file_id"], items["two.3mf"]["output_file_id"]} == {o.id for o in outputs}


@pytest.mark.asyncio
async def test_files_that_cannot_be_sliced_as_designed_are_skipped_up_front(
    async_client: AsyncClient, db_session, library_dir
):
    good = await add_file(db_session, library_dir, "good.3mf", make_3mf())
    stl = await add_file(db_session, library_dir, "cube.stl", b"solid c\nendsolid\n")
    sliced = await add_file(db_session, library_dir, "done.gcode.3mf", make_3mf(sliced=True))
    plain = await add_file(db_session, library_dir, "mesh.3mf", make_3mf(settings=False))
    use_sidecar(Sidecar())

    started = await async_client.post(URL, json={"file_ids": [good, stl, sliced, plain, 999999]})

    first = by_name(started.json())
    assert first["cube.stl"]["reason"] == "not_3mf"
    assert first["done.gcode.3mf"]["reason"] == "not_3mf"
    assert first["mesh.3mf"]["reason"] == "no_settings"
    assert first["#999999"]["reason"] == "not_found"
    assert first["good.3mf"]["status"] in ("pending", "running")

    batch = await wait_finished(async_client, started.json()["id"])
    assert by_name(batch)["good.3mf"]["status"] == "done"


@pytest.mark.asyncio
async def test_files_are_sliced_one_at_a_time_across_batches(async_client: AsyncClient, db_session, library_dir):
    ids = [await add_file(db_session, library_dir, f"f{i}.3mf", make_3mf()) for i in range(4)]
    sidecar = Sidecar(delay=0.05)
    use_sidecar(sidecar)

    first = (await async_client.post(URL, json={"file_ids": ids[:2]})).json()
    second = (await async_client.post(URL, json={"file_ids": ids[2:]})).json()
    assert second["status"] == "queued"

    await wait_finished(async_client, first["id"])
    done = await wait_finished(async_client, second["id"])

    assert sidecar.most_at_once == 1
    assert len(sidecar.bodies) == 4
    assert all(item["status"] == "done" for item in done["items"])


@pytest.mark.asyncio
async def test_a_failed_file_does_not_stop_the_rest(async_client: AsyncClient, db_session, library_dir):
    bad = await add_file(db_session, library_dir, "bad.3mf", make_3mf())
    good = await add_file(db_session, library_dir, "good.3mf", make_3mf())
    use_sidecar(Sidecar(fail_names=("bad.3mf",)))

    started = (await async_client.post(URL, json={"file_ids": [bad, good]})).json()
    batch = await wait_finished(async_client, started["id"])

    items = by_name(batch)
    assert items["bad.3mf"]["status"] == "failed"
    assert items["bad.3mf"]["detail"]
    assert items["good.3mf"]["status"] == "done"


@pytest.mark.asyncio
async def test_cancel_lets_the_current_file_finish_and_drops_the_rest(
    async_client: AsyncClient, db_session, library_dir
):
    ids = [await add_file(db_session, library_dir, f"c{i}.3mf", make_3mf()) for i in range(3)]
    sidecar = Sidecar()
    sidecar.release.clear()
    use_sidecar(sidecar)

    started = (await async_client.post(URL, json={"file_ids": ids})).json()
    for _ in range(200):
        if sidecar.running:
            break
        await asyncio.sleep(0.02)
    assert sidecar.running == 1

    cancelled = await async_client.post(f"{URL}/{started['id']}/cancel")
    assert cancelled.status_code == 200
    sidecar.release.set()
    batch = await wait_finished(async_client, started["id"])

    assert batch["status"] == "cancelled"
    assert [item["status"] for item in batch["items"]] == ["done", "cancelled", "cancelled"]
    assert len(sidecar.bodies) == 1


@pytest.mark.asyncio
async def test_cancelling_an_unknown_batch_is_404(async_client: AsyncClient, library_dir):
    assert (await async_client.post(f"{URL}/12345/cancel")).status_code == 404


@pytest.mark.asyncio
async def test_the_swap_only_applies_inside_a_batch(async_client: AsyncClient, db_session, library_dir, monkeypatch):
    """The slice modal's own request goes through upstream's slicing step, even
    with use_embedded_settings, and a batch started after it is not affected."""
    file_id = await add_file(db_session, library_dir, "modal.3mf", make_3mf())
    use_sidecar(Sidecar())
    swapped: list[str] = []
    real = slice_as_designed.slice_embedded

    async def spy(db, **kwargs):
        swapped.append(kwargs["model_filename"])
        return await real(db, **kwargs)

    monkeypatch.setattr(slice_as_designed, "slice_embedded", spy)
    ref = {"source": "standard", "id": "Bambu Lab A1 0.4 nozzle"}

    response = await async_client.post(
        f"/api/v1/library/files/{file_id}/slice",
        json={"printer_preset": ref, "process_preset": ref, "filament_presets": [ref], "use_embedded_settings": True},
    )
    assert response.status_code == 202
    for _ in range(200):
        job = (await async_client.get(f"/api/v1/slice-jobs/{response.json()['job_id']}")).json()
        if job["status"] in ("completed", "failed"):
            break
        await asyncio.sleep(0.05)
    assert job["status"] == "completed", job
    assert swapped == []

    started = (await async_client.post(URL, json={"file_ids": [file_id]})).json()
    await wait_finished(async_client, started["id"])
    assert swapped == ["modal.3mf"]


class TestUpstreamContracts:
    """What this patch reaches into. A rename upstream fails here, not at runtime."""

    def test_the_slicing_step_is_wrapped(self):
        import backend.app.main  # noqa: F401  registers the fork

        wrapped = library._run_slicer_with_fallback
        assert getattr(wrapped, "hyyz17200", False)
        params = inspect.signature(wrapped.upstream).parameters
        assert {"model_bytes", "model_filename", "request", "current_user_id", "job_id"} <= set(params)

    def test_slice_and_persist_still_calls_the_slicing_step_by_module_name(self):
        assert "_run_slicer_with_fallback(" in inspect.getsource(library.slice_and_persist)

    def test_the_slice_route_takes_what_the_batch_passes(self):
        params = inspect.signature(library.slice_library_file).parameters
        assert {"file_id", "request", "db", "current_user", "api_key_cloud_owner", "actor"} <= set(params)

    def test_upstream_helpers_still_exist(self):
        from backend.app.services.slicer_api import SlicerApiService
        from backend.app.utils.threemf_tools import sanitize_project_settings_sentinels

        assert callable(library._slicer_rejection_message)
        assert callable(library._ensure_library_file_visible)
        assert callable(sanitize_project_settings_sentinels)
        params = inspect.signature(SlicerApiService.slice_without_profiles).parameters
        assert {"model_bytes", "model_filename", "plate", "export_3mf", "arrange", "orient"} <= set(params)


@pytest.mark.parametrize(
    ("ids", "plate"),
    [([], None), ([1], 1), ([2], 2), ([1, 2], 0)],
)
def test_plate_to_slice(ids, plate):
    assert slice_as_designed.plate_to_slice(ids) == plate
