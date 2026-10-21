#!/usr/bin/env bash
# Start Kronos Studio. Usage: ./studio/run.sh [--host 0.0.0.0] [--port 7860]
cd "$(dirname "$0")/.." && exec python studio/server.py "$@"
