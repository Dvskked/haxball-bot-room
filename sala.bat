@echo off
title NeptunZinho - Sala HaxBall
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [error] No tienes Node.js instalado. Descargalo en: https://nodejs.org
  echo Una vez instalado, vuelve a abrir este archivo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Instalando dependencias, solo la primera vez...
  call npm install
  if errorlevel 1 (
    echo [error] npm install fallo. Revisa tu conexion a internet y vuelve a intentar.
    pause
    exit /b 1
  )
)
echo.
echo =====================================================
echo  NeptunZinho - arrancando la sala... DEJA ESTA VENTANA
echo  ABIERTA. Para entrar: abre https://www.haxball.com en tu
echo  navegador, pon tu nombre, dale PLAY y busca la sala:
echo    Futsal Pro | NeptunZinho
echo  Al entrar escribe en el chat:  !admin admin
echo =====================================================
echo.
node sala.js
echo.
echo [sala] La sala se cerro. Revisa los mensajes de arriba.
echo [sala] Si habla del token: genera uno NUEVO en
echo        https://www.haxball.com/headlesstoken y ponlo en token.txt
pause