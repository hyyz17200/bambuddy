"""The Enhanced Settings' quick buttons section: which shortcut buttons the frame shows.

Frontend only (quickButtons/): upstream's red bug-report button can be hidden,
and the printer page's Select toggle can get a button that stays on screen, a
round one in the bottom-right corner on a PC and one in the top bar on a phone.
Both off by default, so nothing changes until saved.

The defaults are mirrored in the frontend's quickButtonsSettings.ts.
"""

from pydantic import BaseModel


class QuickButtonSettings(BaseModel):
    hide_bug_report: bool = False
    select_button: bool = False
