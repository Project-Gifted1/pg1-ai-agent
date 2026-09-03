export default function middleware(request) {
  // 1. Allow CORS preflight requests to pass through untouched
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  // 2. Enforce Strict Authentication on all other requests
  const authHeader = request.headers.get('authorization');
  
  if (authHeader) {
    const authValue = authHeader.split(' ')[1];
    try {
      const [user, pwd] = atob(authValue).split(':');
      if (user === (process.env.USER_API_KEY || 'admin') && pwd === (process.env.USER_API_PASS || 'securepassword')) {
        return; // Authentication successful, proceed to endpoint
      }
    } catch (e) {
      // Malformed auth header, fall through to block
    }
  }

  // 3. Block unauthorized access
  return new Response('Access Denied: PG1 Security Matrix', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Project-Gifted1 Secure Matrix"',
    },
  });
}

export const config = {
  // Only protect the API routes, don't block frontend static assets
  matcher: '/api/:path*',
};
