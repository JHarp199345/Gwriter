@echo off
REM GWriter NSM Sidecar — launch script (Windows)
REM Run this before opening Obsidian with GWriter.

cd /d "%~dp0"

REM Activate virtual environment if present
if exist ".venv\Scripts\activate.bat" (
    call .venv\Scripts\activate.bat
    echo ✓ Virtual environment activated
) else if exist "venv\Scripts\activate.bat" (
    call venv\Scripts\activate.bat
    echo ✓ Virtual environment activated
) else (
    echo ⚠  No virtual environment found — using system Python
)

REM Check for .env
if not exist ".env" (
    echo.
    echo ⚠  No .env file found.
    echo    Run: python setup.py
    echo.
)

echo.
echo Starting GWriter NSM Sidecar...
echo Press Ctrl+C to stop.
echo.

python main.py
pause
