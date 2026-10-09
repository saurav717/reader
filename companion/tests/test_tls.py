import asyncio
import os
import ssl
import tempfile
import unittest
from unittest import mock

from cryptography import x509
from cryptography.x509.oid import ExtendedKeyUsageOID

from reader_companion import tls


class CertificateTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        patch = mock.patch.dict(os.environ, {"READER_COMPANION_HOME": self.home.name})
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(self.home.cleanup)

    def test_only_for_this_computer(self):
        self.assertTrue(tls.ensure_certificate())
        certificate = x509.load_pem_x509_certificate(tls.cert_path().read_bytes())
        names = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        self.assertEqual(names.get_values_for_type(x509.DNSName), ["localhost"])
        self.assertEqual([str(ip) for ip in names.get_values_for_type(x509.IPAddress)], ["127.0.0.1"])
        # Not a CA: trusting it lends nothing to any other site.
        self.assertFalse(certificate.extensions.get_extension_for_class(x509.BasicConstraints).value.ca)
        self.assertFalse(certificate.extensions.get_extension_for_class(x509.KeyUsage).value.key_cert_sign)
        self.assertIn(ExtendedKeyUsageOID.SERVER_AUTH, certificate.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value)
        # macOS refuses a TLS certificate valid for more than 825 days.
        self.assertLessEqual((certificate.not_valid_after_utc - certificate.not_valid_before_utc).days, 825)
        self.assertEqual(oct(tls.key_path().stat().st_mode & 0o777), "0o600")

    def test_whatever_the_computer_is_called(self):
        with mock.patch.object(tls.state, "computer_name", return_value="runner-" + "x" * 80):
            self.assertTrue(tls.ensure_certificate())

    def test_kept_until_it_nears_its_end(self):
        tls.ensure_certificate()
        first = tls.cert_path().read_bytes()
        self.assertFalse(tls.ensure_certificate())
        self.assertEqual(tls.cert_path().read_bytes(), first)
        with mock.patch.object(tls, "days_left", return_value=10):
            self.assertTrue(tls.ensure_certificate())
        self.assertNotEqual(tls.cert_path().read_bytes(), first)

    def test_only_macos_needs_it(self):
        self.assertTrue(tls.needed("Darwin"))
        self.assertFalse(tls.needed("Linux"))
        self.assertFalse(tls.needed("Windows"))

    def test_https_reaches_the_server_behind_it(self):
        tls.ensure_certificate()

        async def run():
            async def echo(reader, writer):
                data = await reader.read(100)
                writer.write(b"server got " + data)
                await writer.drain()
                writer.close()

            backend = await asyncio.start_server(echo, "127.0.0.1", 0)
            backend_port = backend.sockets[0].getsockname()[1]
            front = await tls.serve(0, backend_port)
            front_port = front.sockets[0].getsockname()[1]
            client = ssl.create_default_context(cafile=str(tls.cert_path()))  # as a Mac that trusts it
            reader, writer = await asyncio.open_connection("127.0.0.1", front_port, ssl=client, server_hostname="127.0.0.1")
            writer.write(b"hello")
            await writer.drain()
            answer = await asyncio.wait_for(reader.read(100), 5)
            writer.close()
            front.close()
            backend.close()
            return answer

        self.assertEqual(asyncio.run(run()), b"server got hello")


if __name__ == "__main__":
    unittest.main()
