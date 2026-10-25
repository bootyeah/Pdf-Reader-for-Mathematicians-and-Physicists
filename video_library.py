"""Backward compatibility shim for video_library."""
import sys
from app.services import video_service

sys.modules[__name__] = video_service
