/** Keep a native Bash display stable under the host's literal same-cwd rewrite. */
export function displayBashCommand(command: string, hostCwd: string): string {
  // This is a display-input adapter, not a shell parser. Quoting, expansion,
  // relative paths and uncertain path words must retain the original command.
  if (!hostCwd.startsWith('/') || hostCwd.length > 1024 ||
    /[\s\x00-\x1f\x7f\\'"`$;&|<>*?(){}[\]!#]/u.test(hostCwd)) return command
  const prefix = `cd ${hostCwd} && `
  let start = 0
  // Emit a fixed point so the host cannot remove another identical prefix.
  while (command.startsWith(prefix, start)) start += prefix.length
  return start > 0 && start < command.length ? command.slice(start) : command
}
