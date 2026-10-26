# Fora

Run your own organization of agents.

## Desktop logs

Desktop startup logs are stored beside the backend log in `~/.fora/logs/`, or in
`<FORA_DATA_DIR>/logs/` when `FORA_DATA_DIR` is set. On Windows, open
`%USERPROFILE%\.fora\logs` and collect the latest `app_r*.log` file together with
the complete error message and startup time.

App logs rotate daily and after exceeding 8 MiB, retaining the latest seven
files including the active file. Names include the date and time, with a sequence
suffix when needed. Each record is kept complete, so a file can exceed the size
threshold by one record. Records are written and flushed synchronously. Sensitive
values are redacted. If the directory cannot be resolved or a log file cannot be
opened or written, file logging stops after one diagnostic on stderr; startup
continues.

## Domain access

A non-loopback listener accepts domain names without registration. For example:

```sh
fora-web --host 0.0.0.0 --port 2461
```

Point your domain at the machine and open `http://your-domain:2461/`. Routing and
firewall rules must permit access. `::` listens on IPv6; a specific non-loopback
address also accepts domain names. DNS
rebinding protection applies to loopback listeners; non-loopback listeners accept
any valid hostname and allow HTTP or HTTPS origins matching the requested host
and external port.

For an existing reverse proxy forwarding HTTPS to a loopback instance, allow the
public hostname in the instance's startup configuration:

```sh
fora-web --host 127.0.0.1 --port 2461 --public-host fora.example.com
```

The proxy must forward HTTP and WebSocket requests. It can preserve the external
Host or rewrite it to the backend's local Host. Forwarded headers need no
configuration. External HTTPS on port 443 or a custom port works with the same
hostname entry. TLS certificates and proxy installation are managed separately.

Repeat `--public-host` for multiple names, or set
`FORA_PUBLIC_HOSTS=fora.example.com,.example.org`. A leading dot allows the domain
itself and all its subdomains. Add only domains you control; avoid public suffixes
and shared domains. Entries contain a hostname or unbracketed IP address, without
scheme, port, or path. `*` and `*.example.org` are invalid. Explicit CLI entries
replace the entire environment list. Store the list in your startup configuration;
changes take effect at the next normal start.

`fora` and `fora-web` use the same options. Loopback access and this computer's
own names continue to work without configuration. A loopback listener rejects
unlisted domains with an explanation page and a local access link.
