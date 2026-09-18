/* The port-qualified binary.
 *
 * TWO NAMES, ONE PROGRAM. `likeness` is what a user installs and runs;
 * `likeness-go` is what the parity gate runs, so that two ports can be on one
 * PATH at once and be compared by name rather than by whichever the shell
 * resolved first. `likeness which` exists for the same reason.
 *
 * It is the same entry point, not a copy: a second main with its own argument
 * handling would be a second program that only looked identical.
 */

package main

import (
	"os"

	likeness "github.com/voxgig/likeness/go"
)

func main() {
	os.Exit(likeness.Main(os.Args[1:]))
}
