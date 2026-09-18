/* The argv shell. Deliberately thin.
 *
 * Everything it does is turn a process into the core's parameters and turn the
 * core's result back into a process: read argv and the environment, supply a
 * real clock, write the bytes, set the exit code. That thinness is what lets
 * the transcript corpus run WHOLE COMMANDS in-process, with no subprocess, no
 * shell quoting and no five different ways of capturing output.
 *
 * If logic appears here, it is logic the corpus cannot reach.
 */

package main

import (
	"os"

	likeness "github.com/voxgig/likeness/go"
)

func main() {
	os.Exit(likeness.Main(os.Args[1:]))
}
