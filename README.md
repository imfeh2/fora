# Fora

Run your own organization of agents.

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
