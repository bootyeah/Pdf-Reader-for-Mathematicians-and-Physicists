"""Backward compatibility shim for api_settings."""
import sys
from tools.api_manager import settings

sys.modules[__name__] = settings
