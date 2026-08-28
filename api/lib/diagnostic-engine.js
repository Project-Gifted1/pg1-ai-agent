/**
 * Diagnostic Engine Module
 * Pattern-based error analysis and solution generation
 * Identifies common errors and suggests fixes
 */

class DiagnosticEngine {
  constructor() {
    this.errorPatterns = {
      'ENOENT': {
        cause: 'File or directory not found',
        severity: 'medium',
        solutions: [
          'Check the file path exists',
          'Verify file permissions',
          'Ensure file hasn\'t been deleted'
        ]
      },
      'EACCES': {
        cause: 'Permission denied',
        severity: 'high',
        solutions: [
          'Check file/directory permissions',
          'Verify authentication credentials',
          'Ensure user has required access level'
        ]
      },
      'ETIMEDOUT': {
        cause: 'Request timeout - network or service issue',
        severity: 'medium',
        solutions: [
          'Check network connection',
          'Verify API service is online',
          'Increase timeout duration',
          'Retry with exponential backoff'
        ]
      },
      'ECONNREFUSED': {
        cause: 'Connection refused - service may be down',
        severity: 'high',
        solutions: [
          'Verify service is running',
          'Check service port',
          'Review firewall rules',
          'Check DNS resolution'
        ]
      },
      'ENOMEM': {
        cause: 'Out of memory',
        severity: 'critical',
        solutions: [
          'Reduce data size',
          'Free up system memory',
          'Optimize algorithms',
          'Consider streaming approach'
        ]
      },
      'SyntaxError': {
        cause: 'Code syntax issue',
        severity: 'medium',
        solutions: [
          'Review code for typos',
          'Check bracket matching',
          'Verify language syntax rules',
          'Use linter for validation'
        ]
      },
      'TypeError': {
        cause: 'Type mismatch or undefined property access',
        severity: 'medium',
        solutions: [
          'Check variable types',
          'Verify property existence',
          'Add null checks',
          'Review function signatures'
        ]
      },
      'ReferenceError': {
        cause: 'Undefined variable or function',
        severity: 'medium',
        solutions: [
          'Define missing variable',
          'Import required module',
          'Check variable scope',
          'Verify function exists'
        ]
      },
      '401': {
        cause: 'Authentication failed',
        severity: 'high',
        solutions: [
          'Verify API key/token validity',
          'Check authentication headers',
          'Ensure credentials not expired',
          'Review permission scope'
        ]
      },
      '403': {
        cause: 'Permission denied by API',
        severity: 'high',
        solutions: [
          'Check user permissions',
          'Verify token scope',
          'Review access policies',
          'Request elevated permissions if needed'
        ]
      },
      '404': {
        cause: 'Resource not found',
        severity: 'medium',
        solutions: [
          'Verify resource exists',
          'Check URL/path correctness',
          'Review resource ID',
          'Check if resource was deleted'
        ]
      },
      '429': {
        cause: 'Rate limit exceeded',
        severity: 'medium',
        solutions: [
          'Implement backoff strategy',
          'Reduce request frequency',
          'Check rate limit headers',
          'Consider caching responses'
        ]
      },
      '500': {
        cause: 'Server error - service issue',
        severity: 'high',
        solutions: [
          'Retry request',
          'Check service status',
          'Review server logs',
          'Contact service support'
        ]
      },
      '503': {
        cause: 'Service unavailable',
        severity: 'high',
        solutions: [
          'Wait for service recovery',
          'Check status page',
          'Implement retry logic',
          'Switch to fallback service'
        ]
      }
    };
  }

  diagnose(errorMessage, context = '') {
    const diagnosis = {
      error: errorMessage,
      context,
      patterns: [],
      solutions: []
    };

    for (const [pattern, info] of Object.entries(this.errorPatterns)) {
      if (errorMessage.includes(pattern) || errorMessage.toUpperCase().includes(pattern)) {
        diagnosis.patterns.push({
          pattern,
          cause: info.cause,
          severity: info.severity
        });
        diagnosis.solutions.push(...info.solutions);
      }
    }

    if (diagnosis.patterns.length === 0) {
      diagnosis.patterns.push({
        pattern: 'UNKNOWN',
        cause: 'Could not identify error pattern',
        severity: 'unknown'
      });
      diagnosis.solutions.push(
        'Provide full error stack trace',
        'Include reproduction steps',
        'Check recent code changes',
        'Review debug logs'
      );
    }

    return diagnosis;
  }

  validateSolution(solution, validationType = 'syntax') {
    const validation = {
      solution: solution.substring(0, 200),
      validationType,
      passed: true,
      warnings: [],
      recommendations: []
    };

    if (validationType === 'syntax') {
      try {
        new Function(solution);
        validation.passed = true;
      } catch (e) {
        validation.passed = false;
        validation.error = e.message;
      }
    } else if (validationType === 'logic') {
      validation.warnings.push('Logic validation requires full context - manual review recommended');
    } else if (validationType === 'compatibility') {
      validation.warnings.push('Compatibility check: ensure dependencies are available');
      if (solution.includes('require(') || solution.includes('import ')) {
        validation.recommendations.push('Verify all imports/requires are in package.json');
      }
    } else if (validationType === 'performance') {
      if (solution.length > 10000) {
        validation.warnings.push('Large code block - review for optimization opportunities');
      }
      if (solution.includes('while(true)') || solution.includes('for(;;)')) {
        validation.warnings.push('Infinite loop detected - ensure proper exit condition');
      }
    }

    return validation;
  }

  suggestDebugStrategy(errorType) {
    const strategies = {
      'timeout': [
        'Increase timeout threshold',
        'Add retry with exponential backoff',
        'Check network latency',
        'Reduce request size'
      ],
      'authentication': [
        'Verify token/key validity',
        'Check credential format',
        'Review authentication headers',
        'Test with new credentials'
      ],
      'parsing': [
        'Validate input format',
        'Check encoding',
        'Review schema/format',
        'Test with sample data'
      ],
      'memory': [
        'Profile memory usage',
        'Optimize data structures',
        'Implement streaming',
        'Reduce cache size'
      ],
      'logic': [
        'Add logging/tracing',
        'Test edge cases',
        'Review algorithm',
        'Add assertions'
      ]
    };

    return strategies[errorType] || strategies['logic'];
  }

  getSeverityLevel(severity) {
    const levels = {
      'critical': { level: 0, color: 'red', action: 'ESCALATE' },
      'high': { level: 1, color: 'orange', action: 'URGENT_FIX' },
      'medium': { level: 2, color: 'yellow', action: 'FIX_SOON' },
      'low': { level: 3, color: 'green', action: 'NOTE' }
    };
    return levels[severity] || levels['medium'];
  }
}

module.exports = DiagnosticEngine;