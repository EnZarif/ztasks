@echo off
cd /d "%~dp0"
echo Starting Zarif Central Hub...
echo Open your browser and go to: http://localhost:8000/
echo Press Ctrl+C to stop the server.
start /min cmd /c "cd /d "%~dp0watcher" && node watch.js"
start http://localhost:8000/
python3 -m http.server 8000
pause
