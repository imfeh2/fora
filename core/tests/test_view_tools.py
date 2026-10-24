from __future__ import annotations

from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from PIL import Image
from pydantic_ai.messages import ModelResponse, TextPart
from pydantic_ai.models.function import FunctionModel

from fora.adapters.execution.manager import ExecutionManager
from fora.adapters.files.tree import DirectoryTree
from fora.adapters.files.uploads import DirectoryUploads, decode_image
from fora.adapters.model.runner import PydanticModelRunner
from fora.adapters.sqlite.agent import SqliteAgentStore
from fora.adapters.sqlite.store import SqliteStore
from fora.runtime.reminder import TurnRequest
from fora.services.uploads import Uploads
from fora.tools import AgentTools, Dependencies
from fora.tools.authorize import Actor

MAIN = 2
HUMAN = 1


class Settings:
    def get_settings(self, section: str) -> object:
        if section == "model":
            return {
                "api_type": "openai-chat",
                "base_url": "https://example.invalid/v1",
                "api_key": "unused",
                "model": "view-tools-test",
            }
        return None


@pytest.fixture
def world(tmp_path: Path):
    store = SqliteStore(tmp_path / "fora.sqlite3")
    agent_store = SqliteAgentStore(store._db)
    store.create_member("human", "You")
    store.create_member("agent", "Main")

    def agent_directory_for(member_id: int) -> Path:
        path = tmp_path / "agents" / str(member_id)
        path.mkdir(parents=True, exist_ok=True)
        return path

    deps = Dependencies(
        store=store,
        history=agent_store,
        settings=agent_store,
        execution=ExecutionManager(enforce=False),
        agent_directory_for=agent_directory_for,
        decode_image=decode_image,
        uploads=Uploads(store, DirectoryUploads(tmp_path / "uploads")),
        library_tree=DirectoryTree(tmp_path / "library"),
        workspace_tree_for=lambda member_id: DirectoryTree(
            tmp_path / "agents" / str(member_id) / "workspace"
        ),
    )
    yield deps
    deps.execution.close()
    store.close()


def _turn_request(agent_id: int) -> TurnRequest:
    return TurnRequest(
        agent_id=agent_id,
        sequence=1,
        agent_name="Main",
        prompt="View an image.",
        reminder=None,
        history_json="[]",
        resident="",
        environment=lambda: "environment",
        ephemeral=lambda: "",
        persist=lambda messages: None,
    )


def test_view_image_reads_a_local_png(world, tmp_path: Path) -> None:
    path = tmp_path / "sample.png"
    Image.new("RGB", (3, 2), "red").save(path)

    result = AgentTools(world, Actor(MAIN, True)).view_image(str(path))

    assert result.path == str(path)
    assert result.image.media_type == "image/png"
    assert (result.image.width, result.image.height) == (3, 2)
    assert result.image.data == path.read_bytes()


def test_view_image_reads_the_path_from_discussion_read(world) -> None:
    tools = AgentTools(world, Actor(MAIN, True))
    discussion = tools.create_discussion("Pictures", [HUMAN])
    buffer = BytesIO()
    Image.new("RGB", (5, 4), "blue").save(buffer, format="PNG")
    data = buffer.getvalue()
    upload = world.uploads.create(
        discussion["id"], MAIN, str(uuid4()), "sample.png", len(data), "image/png"
    )
    record, stream = world.uploads.begin(upload.id, MAIN)
    with stream:
        stream.write(data)
    attachment = world.uploads.complete(record)
    world.uploads.end(record)
    tools.send_message(
        discussion["id"], "@You have a look.", attachment_ids=[attachment.id]
    )

    read = tools.read_discussion(discussion["id"])
    path = read["messages"][-1]["attachments"][0]["path"]
    result = tools.view_image(path)

    assert result.path == path
    assert result.image.media_type == "image/png"
    assert (result.image.width, result.image.height) == (5, 4)
    assert result.image.data == data


def test_only_view_image_is_offered_to_the_model(world) -> None:
    seen: list[list[str]] = []

    def respond(messages: Any, info: Any) -> ModelResponse:
        del messages
        seen.append([tool.name for tool in info.function_tools])
        return ModelResponse(parts=[TextPart("done")])

    runner = PydanticModelRunner(
        Settings(), build_model=lambda config: FunctionModel(respond)
    )
    outcome = runner.run(_turn_request(MAIN), AgentTools(world, Actor(MAIN, True)))

    assert outcome.error is None
    assert seen, "the model was never asked"
    assert "view_image" in seen[0]
    assert "view_attachment" not in seen[0]
