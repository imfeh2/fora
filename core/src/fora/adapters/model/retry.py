from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any

import anthropic
import httpx
import httpx2
import openai
from google.genai.errors import APIError as GoogleAPIError
from pydantic_ai import RunContext
from pydantic_ai.exceptions import ModelAPIError, ModelHTTPError
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    ModelResponseStreamEvent,
)
from pydantic_ai.models import Model, ModelRequestParameters, StreamedResponse
from pydantic_ai.models.wrapper import WrapperModel
from pydantic_ai.settings import ModelSettings
from tenacity import AsyncRetrying, RetryCallState, retry_if_exception
from tenacity.stop import stop_base
from tenacity.wait import wait_random_exponential

from fora.runtime.reminder import ModelRequestControl

logger = logging.getLogger("fora.model")


def is_transient(error: BaseException) -> bool:
    if isinstance(
        error, ModelHTTPError | openai.APIStatusError | anthropic.APIStatusError
    ):
        return error.status_code == 429 or 500 <= error.status_code < 600
    if isinstance(error, GoogleAPIError):
        return error.code == 429 or error.code is not None and 500 <= error.code < 600
    if isinstance(
        error,
        TimeoutError
        | ConnectionError
        | httpx.TimeoutException
        | httpx.NetworkError
        | httpx.RemoteProtocolError
        | httpx2.TimeoutException
        | httpx2.NetworkError
        | httpx2.RemoteProtocolError
        | openai.APIConnectionError
        | anthropic.APIConnectionError,
    ):
        return True
    if isinstance(error, ModelAPIError) and error.__cause__ is not None:
        return is_transient(error.__cause__)
    return False


class _BudgetStop(stop_base):
    def __init__(self, budget: RequestRetry) -> None:
        self.budget = budget

    def __call__(self, retry_state: RetryCallState) -> bool:
        if self.budget.remaining < 1:
            self.budget.exhausted()
            return True
        return False


class RequestRetry:
    def __init__(
        self, control: ModelRequestControl, agent_id: int, sequence: int
    ) -> None:
        self.control = control
        self.agent_id = agent_id
        self.sequence = sequence
        self.elapsed = 0.0
        self.retries = 0
        self.last_error: BaseException | None = None
        self._started = 0.0
        self.deadline: float | None = None
        self._failed_elapsed = 0.0
        self._exhausted = False

    @property
    def remaining(self) -> float:
        return max(0.0, 600.0 - self.elapsed)

    def exhausted(self) -> None:
        if not self._exhausted:
            self._exhausted = True
            logger.warning(
                "Model retry budget exhausted agent=%s turn=%s elapsed_seconds=%.3f remaining_seconds=%.3f last_error=%s",
                self.agent_id,
                self.sequence,
                self.elapsed,
                self.remaining,
                type(self.last_error).__name__,
            )

    def check(self) -> None:
        self.control.check()
        if self.remaining < 1:
            self.exhausted()
            assert self.last_error is not None
            raise self.last_error

    def _before(self, state: RetryCallState) -> None:
        self.check()
        self._started = time.monotonic()

    def _after(self, state: RetryCallState) -> None:
        self.control.check()
        assert state.outcome is not None
        error = state.outcome.exception()
        assert error is not None
        self.failed(error)

    def failed(self, error: BaseException) -> None:
        self.last_error = error
        self._failed_elapsed = time.monotonic() - self._started
        self.elapsed += self._failed_elapsed

    async def _wait(self, seconds: float) -> None:
        self.control.check()
        started = time.monotonic()
        self.retries += 1
        try:
            await self.control.wait(min(seconds, self.remaining))
        finally:
            waited = time.monotonic() - started
            self.elapsed += waited
            error = self.last_error
            status = (
                error.status_code
                if isinstance(
                    error,
                    ModelHTTPError | openai.APIStatusError | anthropic.APIStatusError,
                )
                else error.code
                if isinstance(error, GoogleAPIError)
                else None
            )
            logger.warning(
                "Model retry agent=%s turn=%s retry=%s failed_seconds=%.3f wait_seconds=%.3f last_error=%s status=%s",
                self.agent_id,
                self.sequence,
                self.retries,
                self._failed_elapsed,
                waited,
                type(error).__name__,
                status,
            )

    async def run[T](self, operation: Callable[[], Awaitable[T]]) -> T:
        attempt_number = 0

        async def attempt() -> T:
            nonlocal attempt_number
            timeout = self.remaining if attempt_number else None
            self.deadline = time.monotonic() + timeout if timeout is not None else None
            attempt_number += 1
            try:
                async with asyncio.timeout(timeout):
                    return await operation()
            except Exception:
                self.control.check()
                raise

        return await AsyncRetrying(
            retry=retry_if_exception(is_transient),
            stop=_BudgetStop(self),
            wait=wait_random_exponential(multiplier=1, max=30),
            before=self._before,
            after=self._after,
            sleep=self._wait,
            reraise=True,
        )(attempt)


class RetryingModel(WrapperModel):
    def __init__(self, wrapped: Model, retry: RequestRetry) -> None:
        super().__init__(wrapped)
        self.retry = retry

    async def request(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> ModelResponse:
        response = await self.retry.run(
            lambda: self.wrapped.request(
                messages, model_settings, model_request_parameters
            )
        )
        self.retry.control.check()
        return response

    @asynccontextmanager
    async def request_stream(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
        run_context: RunContext[Any] | None = None,
    ) -> AsyncIterator[StreamedResponse]:
        async def open_stream() -> tuple[
            AsyncExitStack,
            StreamedResponse,
            AsyncIterator[ModelResponseStreamEvent],
            list[ModelResponseStreamEvent],
        ]:
            stack = AsyncExitStack()
            try:
                response = await stack.enter_async_context(
                    self.wrapped.request_stream(
                        messages, model_settings, model_request_parameters, run_context
                    )
                )
                iterator = response.__aiter__()
                buffered: list[ModelResponseStreamEvent] = []
                async for event in iterator:
                    self.retry.control.check()
                    buffered.append(event)
                    if any(part.has_content() for part in response.get().parts):
                        break
                self.retry.control.check()
                return stack, response, iterator, buffered
            except BaseException:
                await stack.aclose()
                raise

        stack, response, iterator, buffered = await self.retry.run(open_stream)

        async def events() -> AsyncIterator[ModelResponseStreamEvent]:
            timeout = (
                max(0.0, self.retry.deadline - time.monotonic())
                if self.retry.deadline is not None
                else None
            )
            try:
                async with asyncio.timeout(timeout):
                    for event in buffered:
                        self.retry.control.check()
                        yield event
                    async for event in iterator:
                        self.retry.control.check()
                        yield event
                    self.retry.control.check()
            except Exception as error:
                self.retry.control.check()
                self.retry.failed(error)
                if self.retry.remaining < 1:
                    self.retry.exhausted()
                raise

        async with stack:
            self.retry.control.check()
            response._event_iterator = events()
            yield response
            self.retry.control.check()
