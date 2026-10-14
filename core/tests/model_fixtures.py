from contextlib import nullcontext

from fora.ports.agent import GenerationKey


class GenerationRecorderStub:
    def generation_session(self):
        return nullcontext()

    def generation_key(self, handle, part_index):
        return GenerationKey(2, 1, handle.ordinal, part_index, handle.request_id, "run")

    def generation(self, handle, part_index, update):
        pass
