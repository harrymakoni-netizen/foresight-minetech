"""Stateless Vercel compute. Node owns durable jobs, access control and cancellation.
No local filesystem or background thread is used by this function.
"""
import hmac
import json
import os
import time
from http.server import BaseHTTPRequestHandler
from services.simulator.engine import solve, validate, ValidationError
from services.simulator.ensemble import ensemble, validate_ranges


def calculate(body, workspace_id, seconds=120):
    scenario = body['scenario']
    if scenario.get('workspaceId') != workspace_id:
        raise PermissionError('Workspace mismatch')
    validate(scenario)
    deadline = time.monotonic() + seconds
    cancelled = lambda: time.monotonic() >= deadline
    if body.get('sensitivity'):
        validate_ranges(scenario, body['sensitivity'])
        result = ensemble(scenario, body['sensitivity'], cancelled)
    else:
        result = solve(scenario, cancelled)
    if result['status'] != 'completed':
        raise TimeoutError('Time budget exceeded. Reduce the horizon, sample count or integration detail and retry.')
    encoded = json.dumps(result, allow_nan=False, separators=(',', ':')).encode()
    if len(encoded) > 4 * 1024 * 1024:
        raise ValidationError('Result exceeds the response budget. Increase the output interval or reduce sample count.')
    return encoded


class handler(BaseHTTPRequestHandler):
    def send(self, status, body):
        encoded = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_POST(self):
        token = os.environ.get('FORESIGHT_WORKER_TOKEN', '')
        if len(token) < 32 or not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
            return self.send(401, {'error': 'Worker credential required'})
        try:
            size = int(self.headers.get('Content-Length', 0))
            if not 0 < size <= 200000:
                return self.send(413, {'error': 'Body limit exceeded'})
            body = json.loads(self.rfile.read(size))
            return self.send(200, calculate(body, self.headers.get('X-Workspace-Id', '')))
        except PermissionError:
            return self.send(403, {'error': 'Workspace mismatch'})
        except (ValidationError, ValueError, KeyError, TypeError) as error:
            return self.send(422, {'error': str(error)[:500]})
        except TimeoutError as error:
            return self.send(503, {'error': str(error)})
        except Exception:
            return self.send(500, {'error': 'Simulation could not complete. The saved scenario is unchanged.'})
