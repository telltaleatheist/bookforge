@echo off
echo Building BookForge for Windows x64...
call npm run electron:build -- --win --x64
if %errorlevel% neq 0 (
    echo Build failed!
    pause
    exit /b %errorlevel%
)
echo Build complete! Output in release folder.
pause
