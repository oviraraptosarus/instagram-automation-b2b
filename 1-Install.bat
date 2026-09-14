@echo off
echo ===========================================
echo INSTAGRAM AI AUTOPILOT - INSTALLATION
echo ===========================================
echo Make sure you have NodeJS installed.
echo Press any key to start installing packages.
pause

npm install
call npx playwright install chromium

echo ===========================================
echo INSTALLATION COMPLETE!
echo Next steps: Run "2-Login.bat"
echo ===========================================
pause
