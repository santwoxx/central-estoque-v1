@echo off
echo.
echo ==================================================
echo   Enviando alteracoes para o GitHub (CentralEstoque)
echo ==================================================
echo.

:: Add modified files
git add .

:: Commit changes
git commit -m "Melhorias: painel estatistico, exportacao CSV e paginacao de estoque"

:: Set remote URL
git remote remove origin 2>nul
git remote add origin https://github.com/santwoxx/central-estoque-v1.git

:: Rename branch to main
git branch -M main

echo.
echo Conectando ao GitHub para o envio...
echo.

:: Push changes
git push -u origin main

echo.
echo ==================================================
echo   Concluido! Pressione qualquer tecla para sair.
echo ==================================================
pause
