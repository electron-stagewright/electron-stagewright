# Architecture Decision Records

The canonical, public record of every architectural decision in Electron
Stagewright. Each ADR captures one decision: its context, the decision itself,
the alternatives considered, and the consequences. Amendments land as a
`Status Update` section appended to the original ADR — history is never
rewritten.

| ADR                                                      | Title                                                     | Status                                           |
| -------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| [ADR-001](./001-naming-and-license.md)                   | Naming and License                                        | Accepted                                         |
| [ADR-002](./002-runtime-and-language.md)                 | Runtime and Language Choice                               | Accepted                                         |
| [ADR-003](./003-transport-abstraction.md)                | Transport Abstraction                                     | Accepted (amended: CDP and injector implemented) |
| [ADR-004](./004-plugin-model.md)                         | Plugin model                                              | Accepted                                         |
| [ADR-005](./005-snapshot-schema-v1.md)                   | Snapshot schema v1 + renderer-injected tool layer         | Accepted (amended: compact diff encoding)        |
| [ADR-006](./006-error-code-registry.md)                  | Error Code Registry and Agent-UX Response Envelope        | Accepted                                         |
| [ADR-007](./007-agent-native-ux-principles.md)           | Agent-native UX principles                                | Accepted                                         |
| [ADR-008](./008-server-and-tool-dispatcher.md)           | MCP server, tool dispatcher, and tool-definition contract | Accepted                                         |
| [ADR-009](./009-trace-artifact-and-dispatch-observer.md) | Trace artifact format and dispatch-observer seam          | Accepted                                         |
| [ADR-010](./010-ipc-plugin.md)                           | IPC capture/invoke/stub plugin                            | Accepted                                         |
| [ADR-011](./011-operation-timeout.md)                    | Operation-timeout backstop at the dispatch boundary       | Accepted                                         |
| [ADR-012](./012-production-validation-plugin.md)         | Production validation plugin                              | Accepted                                         |
