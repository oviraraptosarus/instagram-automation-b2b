@echo off
echo ===========================================
echo STOPPING INSTAGRAM AI AUTOPILOT WORKERS
echo ===========================================
echo Stopping active automation processes gracefully...
node -e "require('./dist/utils/process-control').ProcessControl.killProcess('daemon')"
echo Done! Bot daemon stopped cleanly.
pause
