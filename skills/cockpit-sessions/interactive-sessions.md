# Interactive Sessions

## Terminal Interaction

```bash
cockpit-cli key "$id" escape            # interrupt, dismiss menu
cockpit-cli key "$id" enter             # confirm
cockpit-cli input "$id" "some message"  # type text into terminal
cockpit-cli capture "$id"               # see current terminal state
```

`input` on an **idle** (finished) session sends text but won't be tracked as a conversation turn — use `followup` instead for new prompts.

## Pin / Unpin

Prevents a slot from being reclaimed (offloaded) while you're in the middle of an interactive sequence — menus, multi-step key flows, anything where losing the slot mid-action would break the interaction.

```bash
cockpit-cli pin "$id"        # default: 120 seconds
cockpit-cli pin "$id" 300    # 5 minutes
cockpit-cli unpin "$id"      # release immediately
```

**Don't pin for basic messaging.** `followup` handles idle sessions automatically. Pin only when you're sending a sequence of `key`/`input` commands that must land in the same session without interruption.

## Stopping a Session

```bash
cockpit-cli stop "$id"       # sends Escape to interrupt
```

Interrupts a running session without killing the slot. The session returns to idle after Claude stops.
