"""Notes on printers: descriptions and things to do mark the card, done ones
stay as its history (hyyz17200)."""

import typing

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.core.printer_scope import PrinterScope
from backend.app.hyyz17200 import api, printer_notes
from backend.app.hyyz17200.models import PrinterNote

SUMMARY_URL = "/api/v1/hyyz17200/printers/notes/summary"


def _notes_url(printer_id: int, note_id: int | None = None) -> str:
    base = f"/api/v1/hyyz17200/printers/{printer_id}/notes"
    return base if note_id is None else f"{base}/{note_id}"


def test_the_api_takes_every_kind_the_model_knows():
    assert set(typing.get_args(api.NoteKind)) == set(printer_notes.KINDS)


class TestApi:
    @pytest.mark.asyncio
    async def test_add_list_and_summary(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory(name="A1-01")
        assert (await async_client.get(SUMMARY_URL)).json() == []
        assert (await async_client.get(_notes_url(printer.id))).json() == []

        info = await async_client.post(_notes_url(printer.id), json={"body": "  0.6 nozzle fitted  "})
        assert info.status_code == 200
        assert info.json()["body"] == "0.6 nozzle fitted"  # trimmed
        assert info.json()["kind"] == "info"  # the default
        assert info.json()["created_at"] is not None

        # Only descriptions: counted, and the newest is the tooltip.
        assert (await async_client.get(SUMMARY_URL)).json() == [
            {"printer_id": printer.id, "todo_count": 0, "info_count": 1, "latest": "0.6 nozzle fitted"}
        ]

        await async_client.post(_notes_url(printer.id), json={"body": "Z axis squeaks", "kind": "todo"})
        await async_client.post(_notes_url(printer.id), json={"body": "Belt worn", "kind": "todo"})
        await async_client.post(_notes_url(printer.id), json={"body": "BMCU in AMS Lite mode"})

        # A thing to do beats a newer description for the tooltip.
        assert (await async_client.get(SUMMARY_URL)).json() == [
            {"printer_id": printer.id, "todo_count": 2, "info_count": 2, "latest": "Belt worn"}
        ]

    @pytest.mark.asyncio
    async def test_a_logged_note_marks_nothing(self, async_client: AsyncClient, printer_factory):
        """kind=done records something already done: history only, no marker."""
        printer = await printer_factory()
        response = await async_client.post(_notes_url(printer.id), json={"body": "Swapped nozzle", "kind": "done"})
        assert response.json()["kind"] == "done"
        assert response.json()["resolved_at"] is not None

        assert (await async_client.get(SUMMARY_URL)).json() == []
        assert len((await async_client.get(_notes_url(printer.id))).json()) == 1

    @pytest.mark.asyncio
    async def test_an_unknown_kind_is_refused(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        assert (await async_client.post(_notes_url(printer.id), json={"body": "x", "kind": "open"})).status_code == 422
        note = (await async_client.post(_notes_url(printer.id), json={"body": "x"})).json()
        response = await async_client.patch(_notes_url(printer.id, note["id"]), json={"kind": "urgent"})
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_order_is_info_then_todo_then_done(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        for body, kind in [
            ("old todo", "todo"),
            ("old done", "done"),
            ("old info", "info"),
            ("new todo", "todo"),
            ("new done", "done"),
            ("new info", "info"),
        ]:
            await async_client.post(_notes_url(printer.id), json={"body": body, "kind": kind})

        bodies = [n["body"] for n in (await async_client.get(_notes_url(printer.id))).json()]
        assert bodies == ["new info", "old info", "new todo", "old todo", "new done", "old done"]

    @pytest.mark.asyncio
    async def test_resolve_reopen_and_edit(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        note = (await async_client.post(_notes_url(printer.id), json={"body": "Check fan", "kind": "todo"})).json()
        url = _notes_url(printer.id, note["id"])

        resolved = (await async_client.patch(url, json={"kind": "done"})).json()
        assert resolved["kind"] == "done"
        assert resolved["resolved_at"] is not None
        assert resolved["edited_at"] is None  # changing the kind is not an edit
        assert (await async_client.get(SUMMARY_URL)).json() == []

        reopened = (await async_client.patch(url, json={"kind": "todo"})).json()
        assert reopened["kind"] == "todo"
        assert reopened["resolved_at"] is None

        # A todo can become a standing description, and stays unresolved.
        described = (await async_client.patch(url, json={"kind": "info"})).json()
        assert described["kind"] == "info"
        assert described["resolved_at"] is None

        edited = (await async_client.patch(url, json={"body": "Fan replaced in May"})).json()
        assert edited["body"] == "Fan replaced in May"
        assert edited["edited_at"] is not None
        assert edited["kind"] == "info"

        # Sending the same text again is not an edit.
        same = (await async_client.patch(url, json={"body": "Fan replaced in May"})).json()
        assert same["edited_at"] == edited["edited_at"]

    @pytest.mark.asyncio
    async def test_null_leaves_fields_alone(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        note = (await async_client.post(_notes_url(printer.id), json={"body": "Keep me", "kind": "todo"})).json()

        response = await async_client.patch(_notes_url(printer.id, note["id"]), json={"body": None, "kind": None})
        assert response.status_code == 200
        assert response.json()["body"] == "Keep me"
        assert response.json()["kind"] == "todo"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("body", ["", "   ", "x" * (printer_notes.BODY_MAX_LENGTH + 1)])
    async def test_empty_or_long_text_is_refused(self, async_client: AsyncClient, printer_factory, body):
        printer = await printer_factory()
        assert (await async_client.post(_notes_url(printer.id), json={"body": body})).status_code == 422

        note = (await async_client.post(_notes_url(printer.id), json={"body": "ok"})).json()
        assert (await async_client.patch(_notes_url(printer.id, note["id"]), json={"body": body})).status_code == 422

    @pytest.mark.asyncio
    async def test_delete(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        note = (await async_client.post(_notes_url(printer.id), json={"body": "Oops"})).json()

        assert (await async_client.delete(_notes_url(printer.id, note["id"]))).status_code == 204
        assert (await async_client.get(_notes_url(printer.id))).json() == []
        assert (await async_client.delete(_notes_url(printer.id, note["id"]))).status_code == 404

    @pytest.mark.asyncio
    async def test_unknown_printer(self, async_client: AsyncClient):
        assert (await async_client.get(_notes_url(9999))).status_code == 404
        assert (await async_client.post(_notes_url(9999), json={"body": "x"})).status_code == 404

    @pytest.mark.asyncio
    async def test_a_note_is_reached_only_through_its_own_printer(self, async_client: AsyncClient, printer_factory):
        """The scope check runs on the path's printer, so a note id under another
        printer must not resolve."""
        mine = await printer_factory(name="A1-01")
        other = await printer_factory(name="A1-02")
        note = (await async_client.post(_notes_url(other.id), json={"body": "theirs", "kind": "todo"})).json()

        assert (await async_client.patch(_notes_url(mine.id, note["id"]), json={"kind": "done"})).status_code == 404
        assert (await async_client.delete(_notes_url(mine.id, note["id"]))).status_code == 404
        assert (await async_client.get(_notes_url(other.id))).json()[0]["kind"] == "todo"


class TestStorage:
    @pytest.mark.asyncio
    async def test_deleting_the_printer_drops_its_notes(self, db_session, printer_factory):
        """SQLite reuses a deleted printer's id, so the notes must not outlive it."""
        printer = await printer_factory()
        for kind in printer_notes.KINDS:
            await printer_notes.add_note(db_session, printer.id, kind, kind, None)

        await db_session.delete(printer)
        await db_session.commit()

        assert (await db_session.execute(select(PrinterNote))).scalars().all() == []

    @pytest.mark.asyncio
    async def test_left_behind_notes_are_ignored(self, db_session, printer_factory):
        printer = await printer_factory()
        db_session.add(PrinterNote(printer_id=printer.id + 100, body="orphan", kind="todo"))
        await db_session.commit()

        assert await printer_notes.summaries(db_session, PrinterScope().allows) == []

    @pytest.mark.asyncio
    async def test_summary_follows_the_printer_scope(self, db_session, printer_factory):
        a = await printer_factory(name="A1-01")
        b = await printer_factory(name="A1-02")
        await printer_notes.add_note(db_session, a.id, "a", "todo", None)
        await printer_notes.add_note(db_session, b.id, "b", "info", None)

        seen = await printer_notes.summaries(db_session, PrinterScope(frozenset({b.id})).allows)
        assert [s["printer_id"] for s in seen] == [b.id]

    @pytest.mark.asyncio
    async def test_the_author_is_recorded(self, db_session, printer_factory):
        printer = await printer_factory()
        note = await printer_notes.add_note(db_session, printer.id, "x", "todo", "alice")
        note = await printer_notes.update_note(db_session, note, body="y", kind="done", by="bob")

        assert (note.created_by, note.edited_by, note.resolved_by) == ("alice", "bob", "bob")
