@echo off
echo ===========================================
echo STOPPING INSTAGRAM AI AUTOPILOT
echo ===========================================
echo Cleaning up browser and node processes...
taskkill /F /IM node.exe >nul 2>&1
echo Done! The bot is completely stopped.
pause
