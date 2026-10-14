from contextlib import asynccontextmanager

import pytest
from pydantic_ai.models import CompletedStreamedResponse
from pydantic_ai.models.function import FunctionModel


@pytest.fixture(autouse=True)
def completed_function_stream(monkeypatch):
    original = FunctionModel.request_stream

    @asynccontextmanager
    async def stream(self, messages, settings, parameters, run_context=None):
        if self.stream_function is not None:
            async with original(
                self, messages, settings, parameters, run_context
            ) as response:
                yield response
        else:
            response = await self.request(messages, settings, parameters)
            yield CompletedStreamedResponse(
                response, model_request_parameters=parameters
            )

    monkeypatch.setattr(FunctionModel, "request_stream", stream)
