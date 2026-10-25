"""Backward compatibility shim for api_manager."""
import sys
from tools.api_manager import manager

sys.modules[__name__] = manager

if __name__ == '__main__':
    manager.main()
