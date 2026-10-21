import test from 'node:test'
import assert from 'node:assert/strict'
import { displayBashCommand } from '../hooks/display-input.ts'

test('native Bash display removes only exact literal prefixes matching the observed host cwd', () => {
  const cwd = '/tmp/worktree'
  const rest = "sed -n '1,2p' fixture.txt && cat fixture.txt"
  assert.equal(displayBashCommand(`cd ${cwd} && ${rest}`, cwd), rest)
  assert.equal(displayBashCommand(`cd ${cwd} && cd ${cwd} && ${rest}`, cwd), rest)
  assert.equal(displayBashCommand(rest, cwd), rest)
  assert.equal(displayBashCommand(displayBashCommand(`cd ${cwd} && ${rest}`, cwd), cwd), rest)
  for (const command of [
    `cd '${cwd}' && ${rest}`, `cd "${cwd}" && ${rest}`, `cd ${cwd}/other && ${rest}`,
    `cd ${cwd} &&& ${rest}`, `cd  ${cwd} && ${rest}`, `cd ${cwd}&& ${rest}`,
    ` cd ${cwd} && ${rest}`, `cd ${cwd} ; ${rest}`, `cd ${cwd} || ${rest}`,
    `cd ${cwd} && `, `cd $PWD && ${rest}`, `cd /tmp/other && ${rest}`,
  ]) assert.equal(displayBashCommand(command, cwd), command)
})

test('native Bash display preserves relative, quoted, expanded, unsafe and oversized cwd forms', () => {
  for (const cwd of ['', '.', 'relative', '/tmp/with space', '/tmp/quote\'word', '/tmp/"word',
    '/tmp/$name', '/tmp/`name`', '/tmp/a;pwd', '/tmp/a&pwd', '/tmp/a|pwd', '/tmp/a\\word',
    '/tmp/a\nword', '/tmp/a\0word', '/tmp/a[0]', '/tmp/a*', '/tmp/a?', '/tmp/a#', '/tmp/a!',
    '/tmp/a<word', '/tmp/a>word', '/tmp/a(word)', '/tmp/a{word}', '/' + 'a'.repeat(1024),
    'C:\\worktree']) {
    const command = `cd ${cwd} && cat fixture.txt`
    assert.equal(displayBashCommand(command, cwd), command)
  }
})
