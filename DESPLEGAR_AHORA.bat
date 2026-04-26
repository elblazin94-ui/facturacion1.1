@echo off
echo ========================================
echo   LANZANDO GESTION DE GASTOS A PRODUCCION
echo ========================================
echo.
call firebase use gestion-gastos-wa-2026
echo.
echo Desplegando en Firebase...
call firebase deploy
echo.
echo ========================================
echo   ¡LISTO! YA PUEDES CERRAR ESTA VENTANA
echo   URL: https://gestion-gastos-wa-2026.web.app
echo ========================================
pause
