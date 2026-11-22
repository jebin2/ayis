// Package arch holds no code: its test is the architecture of ayis, written as
// rules the build enforces (docs/architecture.md, "Layers").
//
//	cmd/ayis              wires commands to the process
//	internal/commands/*   one package per command: flags, output, the flow
//	internal/*            what the commands are made of - never imports a command
//	internal/awscfg       the only place AWS clients are configured
package arch
