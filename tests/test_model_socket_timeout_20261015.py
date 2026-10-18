import socket
import urllib.error
import unittest
from unittest.mock import patch

from backend import model_client
from backend.adapter import AdapterError, Config, OpenAICompatibleProvider


def _provider():
    return OpenAICompatibleProvider(
        Config(base_url='https://example.invalid/v1', model='test-model', token='local-test-token')
    )


def _socket_timeout():
    receiver, peer = socket.socketpair()
    try:
        receiver.settimeout(0.01)
        try:
            receiver.recv(1)
        except socket.timeout as error:
            return error
        raise AssertionError('socketpair did not time out')
    finally:
        receiver.close()
        peer.close()


class SocketTimeoutClassificationTests(unittest.TestCase):
    def test_socket_timeout_during_open_is_model_timeout_without_retry(self):
        receiver, peer = socket.socketpair()
        receiver.settimeout(0.01)
        attempts = []

        def open_request(_request, _timeout):
            attempts.append('open')
            receiver.recv(1)

        try:
            with patch.object(model_client, '_open_request', open_request):
                with self.assertRaises(AdapterError) as caught:
                    _provider().complete_json('system', {})
            self.assertEqual(caught.exception.code, 'model_timeout')
            self.assertEqual(attempts, ['open'])
        finally:
            receiver.close()
            peer.close()

    def test_socket_timeout_during_response_read_is_model_timeout_without_retry(self):
        receiver, peer = socket.socketpair()
        receiver.settimeout(0.01)
        attempts = {'open': 0, 'read': 0}

        class Response:
            status = 200
            headers = {'Content-Type': 'application/json'}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                attempts['read'] += 1
                return receiver.recv(1)

        def open_request(_request, _timeout):
            attempts['open'] += 1
            return Response()

        try:
            with patch.object(model_client, '_open_request', open_request):
                with self.assertRaises(AdapterError) as caught:
                    _provider().complete_json('system', {})
            self.assertEqual(caught.exception.code, 'model_timeout')
            self.assertEqual(attempts, {'open': 1, 'read': 1})
        finally:
            receiver.close()
            peer.close()

    def test_url_error_wrapped_socket_timeout_is_model_timeout_without_retry(self):
        timeout = _socket_timeout()
        attempts = []

        def open_request(_request, _timeout):
            attempts.append('open')
            raise urllib.error.URLError(timeout)

        with patch.object(model_client, '_open_request', open_request):
            with self.assertRaises(AdapterError) as caught:
                _provider().complete_json('system', {})
        self.assertEqual(caught.exception.code, 'model_timeout')
        self.assertEqual(attempts, ['open'])

    def test_ordinary_oserror_remains_network_error_without_retry(self):
        attempts = []

        def open_request(_request, _timeout):
            attempts.append('open')
            raise OSError('local synthetic failure')

        with patch.object(model_client, '_open_request', open_request):
            with self.assertRaises(AdapterError) as caught:
                _provider().complete_json('system', {})
        self.assertEqual(caught.exception.code, 'model_network_error')
        self.assertEqual(attempts, ['open'])


if __name__ == '__main__':
    unittest.main()
