/**
 * GitHub Tools Module
 * Handles all GitHub API interactions for repository access
 */

class GitHubTools {
  constructor(githubToken) {
    this.token = githubToken;
    this.owner = 'Project-Gifted1';
    this.repo = 'pg1-ai-agent';
    this.baseUrl = 'https://api.github.com';
  }

  async listDirectory(path = '') {
    try {
      const endpoint = path 
        ? `/repos/${this.owner}/${this.repo}/contents/${path}`
        : `/repos/${this.owner}/${this.repo}/contents`;

      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'pg1-ai-agent'
        }
      });

      if (!response.ok) {
        const error = await response.json();
        return {
          success: false,
          error: error.message || `GitHub API error: ${response.status}`
        };
      }

      const contents = await response.json();
      
      if (!Array.isArray(contents)) {
        return {
          success: false,
          error: 'Path is not a directory'
        };
      }

      return {
        success: true,
        items: contents.map(item => ({
          name: item.name,
          type: item.type,
          path: item.path,
          size: item.size,
          url: item.html_url
        }))
      };
    } catch (err) {
      return {
        success: false,
        error: `Directory listing failed: ${err.message}`
      };
    }
  }

  async readFile(filepath) {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}/contents/${filepath}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Accept': 'application/vnd.github.v3.raw',
            'User-Agent': 'pg1-ai-agent'
          }
        }
      );

      if (!response.ok) {
        const error = await response.json();
        return {
          success: false,
          error: error.message || `GitHub API error: ${response.status}`
        };
      }

      const content = await response.text();
      return {
        success: true,
        filepath,
        content,
        size: content.length
      };
    } catch (err) {
      return {
        success: false,
        error: `File read failed: ${err.message}`
      };
    }
  }

  async searchFiles(pattern) {
    try {
      const query = `repo:${this.owner}/${this.repo} filename:${pattern}`;
      const response = await fetch(
        `${this.baseUrl}/search/code?q=${encodeURIComponent(query)}&per_page=10`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'pg1-ai-agent'
          }
        }
      );

      if (!response.ok) {
        return { success: false, error: 'Search failed' };
      }

      const data = await response.json();
      return {
        success: true,
        items: data.items || []
      };
    } catch (err) {
      return {
        success: false,
        error: `Search failed: ${err.message}`
      };
    }
  }

  async getRepoInfo() {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.owner}/${this.repo}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'pg1-ai-agent'
          }
        }
      );

      if (!response.ok) {
        return { success: false, error: 'Could not fetch repo info' };
      }

      const data = await response.json();
      return {
        success: true,
        info: {
          name: data.name,
          description: data.description,
          language: data.language,
          stars: data.stargazers_count,
          forks: data.forks_count,
          defaultBranch: data.default_branch,
          size: data.size
        }
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to fetch repo info: ${err.message}`
      };
    }
  }
}

module.exports = GitHubTools;