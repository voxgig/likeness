#!/usr/bin/env node
/* Executable entry. The wrapper exists so the compiled source carries no
 * shebang and stays importable by the corpus runner. */
import { main } from '../dist/src/cli.js'
main(process.argv.slice(2)).then(code => { process.exitCode = code })
