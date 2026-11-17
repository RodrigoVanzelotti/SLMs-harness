"""Exception types. The CLI reports HarnessError subclasses without a traceback."""


class HarnessError(Exception):
    """Base class for expected, user-facing errors."""


class SpecError(HarnessError):
    """The spec bundle is invalid or inconsistent."""


class ConfigError(HarnessError):
    """harness.yaml is invalid."""


class LLMError(HarnessError):
    """The model server could not be reached or returned an unusable reply."""


class LockError(HarnessError):
    """Another orchestrator holds the lock for this run."""
