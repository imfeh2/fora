from __future__ import annotations

from dataclasses import dataclass

from fora.core.permissions import Node, render


@dataclass(frozen=True)
class Action:
    node: Node
    target: str | None
    description: str

    def payload(self) -> dict[str, object]:
        return {
            "node": list(self.node),
            "name": render(self.node),
            "target": self.target,
            "description": self.description,
        }


FILES_WRITE: Node = ("files", "write")
LIBRARY_WRITE: Node = ("library", "write")
WORKSPACE_READ: Node = ("workspace", "read")
TOOLS_RUN: Node = ("tools", "run")
DISCUSSION_CREATE: Node = ("discussion", "create")
DISCUSSION_MEMBERS: Node = ("discussion", "members")
DISCUSSION_ARCHIVE: Node = ("discussion", "archive")
MEMBER_CREATE: Node = ("member", "create")
MEMBER_RENAME: Node = ("member", "rename")
MEMBER_PAUSE: Node = ("member", "pause")
MEMBER_RESUME: Node = ("member", "resume")
MEMBER_RESUME_SAFETY: Node = ("member", "resume_safety")
MEMBER_DELETE: Node = ("member", "delete")
MEMBER_MODEL: Node = ("member", "model")
MEMBER_HISTORY: Node = ("member", "history")

BUILTIN: tuple[Action, ...] = (
    Action(
        FILES_WRITE,
        "path",
        "Write files under an absolute path, within the organization's writable "
        "directories. The Library and Member workspaces have their own actions.",
    ),
    Action(LIBRARY_WRITE, "path", "Create, edit, move and delete Library files."),
    Action(
        WORKSPACE_READ,
        "member/path",
        "Read another Member's workspace. Every Member reads and writes its own.",
    ),
    Action(
        TOOLS_RUN,
        None,
        "Run commands. Commands can write only where the Member's write "
        "permissions allow.",
    ),
    Action(DISCUSSION_CREATE, None, "Create Discussions."),
    Action(DISCUSSION_MEMBERS, "discussion", "Change who belongs to a Discussion."),
    Action(DISCUSSION_ARCHIVE, "discussion", "Archive and unarchive a Discussion."),
    Action(MEMBER_CREATE, None, "Create Agents."),
    Action(MEMBER_RENAME, "member", "Rename a Member."),
    Action(MEMBER_PAUSE, "member", "Pause an Agent."),
    Action(MEMBER_RESUME, "member", "Resume a paused Agent."),
    Action(
        MEMBER_RESUME_SAFETY,
        "member",
        "Resume an Agent that a safety check paused.",
    ),
    Action(MEMBER_DELETE, "member", "Delete an Agent."),
    Action(MEMBER_MODEL, "member", "Change an Agent's model selection."),
    Action(MEMBER_HISTORY, "member", "Read an Agent's turn history."),
)
