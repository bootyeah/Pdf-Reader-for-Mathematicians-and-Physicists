"""Backward compatibility shim for phone_tunnel."""
import sys
from app.services import tunnel_service

sys.modules[__name__] = tunnel_service
