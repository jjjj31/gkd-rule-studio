if (process.platform !== 'win32') {
  console.error('This checkout uses Windows dependencies. Run project commands in Windows PowerShell, not WSL.');
  process.exitCode = 1;
}
