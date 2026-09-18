package main

import (
	"os"

	likeness "github.com/voxgig/likeness/go"
)

func main() {
	os.Exit(likeness.Main(os.Args[1:]))
}
