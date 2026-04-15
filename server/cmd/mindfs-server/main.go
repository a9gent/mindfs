package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"mindfs/server/app"
)

var version = "dev"

func main() {
	addr := flag.String("addr", "127.0.0.1:7331", "listen address")
	noRelayer := flag.Bool("no-relayer", false, "disable relay integration")
	flag.Parse()

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	if err := app.Start(ctx, *addr, app.StartOptions{
		NoRelayer: *noRelayer,
		Version:   version,
		Args:      os.Args[1:],
	}); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}
