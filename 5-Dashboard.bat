@echo off
echo ===========================================
echo INSTAGRAM AI AUTOPILOT - DASHBOARD
echo ===========================================
echo Opening the live status dashboard...
echo ===========================================
npm run build
start "" "http://localhost:3456"
node dist/dashboard/standalone.js
pause
