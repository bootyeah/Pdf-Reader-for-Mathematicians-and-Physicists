"""Backward compatibility shim for formula_bridge."""
import sys
from app.services import formula_service

sys.modules[__name__] = formula_service
