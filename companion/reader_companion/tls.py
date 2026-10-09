"""An https address on this computer, for Safari.

Safari won't let an https page call http://127.0.0.1 (Chrome, Edge and Firefox
do), so a site open in Safari can't reach the Companion's Jupyter server. With
a certificate this computer trusts, it can: the Companion also listens on
https://127.0.0.1:47331 and hands every connection, websockets included, to the
server on 47321.

The certificate is made here, on first use, and is for localhost and 127.0.0.1
only, with CA:FALSE: it can't vouch for any other site, so trusting it lends
nothing to anyone who copied it. `reader-companion setup` (or `trust`) adds it
to the login keychain on macOS, which asks for your password once. Elsewhere
there is no Safari, and nothing to do.
"""

from __future__ import annotations

import asyncio
import datetime
import ipaddress
import os
import platform
import ssl
import subprocess
from pathlib import Path

from . import state

DEFAULT_PORT = 47331
LIFETIME_DAYS = 800  # macOS takes no TLS certificate that lasts more than 825 days
RENEW_DAYS = 30


def folder() -> Path:
    return state.config_dir() / "tls"


def cert_path() -> Path:
    return folder() / "localhost.pem"


def key_path() -> Path:
    return folder() / "localhost-key.pem"


def make_certificate() -> None:
    """A new key and a self-signed certificate for localhost and 127.0.0.1, CA:FALSE."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"Reader Companion on {state.computer_name()}"), x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Reader Companion (this computer only)")])
    now = datetime.datetime.now(datetime.timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=LIFETIME_DAYS))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, key_encipherment=False, content_commitment=False, data_encipherment=False, key_agreement=True, key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256())
    )
    folder().mkdir(parents=True, exist_ok=True)
    key_path().write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    os.chmod(key_path(), 0o600)
    cert_path().write_bytes(certificate.public_bytes(serialization.Encoding.PEM))


def days_left() -> float | None:
    """How long the certificate here has left, or None when there is none (or it can't be read)."""
    try:
        from cryptography import x509

        certificate = x509.load_pem_x509_certificate(cert_path().read_bytes())
    except (OSError, ValueError, ImportError):
        return None
    if not key_path().exists():
        return None
    ends = certificate.not_valid_after_utc
    return (ends - datetime.datetime.now(datetime.timezone.utc)).total_seconds() / 86400


def ensure_certificate() -> bool:
    """A certificate with time left, made if needed. True when a new one was made (it needs trusting again)."""
    left = days_left()
    if left is not None and left > RENEW_DAYS:
        return False
    make_certificate()
    return True


def needed(system: str | None = None) -> bool:
    """Only Safari needs it, and Safari is only on macOS: Chrome, Edge and Firefox reach http://127.0.0.1 from an https page."""
    return (system or platform.system()) == "Darwin"


def is_trusted() -> bool:
    return cert_path().exists() and _quiet("security", "verify-cert", "-c", str(cert_path()), "-p", "ssl", "-s", "127.0.0.1")


def trust() -> bool:
    """Asks macOS to trust the certificate, for https only: it shows its own password prompt. Whether it now does."""
    keychain = Path.home() / "Library" / "Keychains" / "login.keychain-db"
    _quiet("security", "add-trusted-cert", "-r", "trustAsRoot", "-p", "ssl", "-k", str(keychain), str(cert_path()), timeout=300)
    return is_trusted()


def _quiet(*command: str, timeout: float = 30) -> bool:
    try:
        return subprocess.run(list(command), capture_output=True, timeout=timeout).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


# ------------------------------------------------------------ the forwarder ----

async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError, ssl.SSLError, OSError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def serve(listen_port: int, target_port: int) -> asyncio.base_events.Server:
    """https on 127.0.0.1:listen_port, every connection handed to http on 127.0.0.1:target_port as it is."""
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.load_cert_chain(str(cert_path()), str(key_path()))

    async def handle(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter) -> None:
        try:
            server_reader, server_writer = await asyncio.open_connection("127.0.0.1", target_port)
        except OSError:
            client_writer.close()
            return
        await asyncio.gather(_pipe(client_reader, server_writer), _pipe(server_reader, client_writer))

    return await asyncio.start_server(handle, "127.0.0.1", listen_port, ssl=context)
