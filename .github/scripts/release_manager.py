#!/usr/bin/env python3
"""
Unified Release Manager Script

This script consolidates all versioning, changelog, and release management logic
previously scattered across multiple workflow files. It uses only standard library
Python modules and handles:

1. PR merges into beta (draft/updated beta prerelease handling)
2. Publishing beta prereleases (finalizing entry + retag + body sync)
3. Converting published betas to a stable draft release
4. Publishing stable releases (finalizing entry + retag + body sync)
"""

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime
from typing import Dict, List, Optional, Tuple, Union
from urllib.request import Request, urlopen
from urllib.parse import quote

# Configuration constants
ESCALATE_BREAKING_POST_PUBLISH = True  # Toggle for mid-series escalation after beta publish

# Category ordering for changelog and releases
CATEGORY_ORDER = [
    'Breaking Changes',
    'Featured Changes', 
    'Bug Fixes',
    'Other Changes'
]

# Label mappings to categories
LABEL_MAPPINGS = {
    'Breaking Changes': ['breaking-change', 'breaking change'],
    'Featured Changes': ['feature', 'enhancement'],
    'Bug Fixes': ['fix', 'bugfix', 'bug'],
    'Other Changes': ['documentation', 'docs', 'dependency']
}

class GitHubAPI:
    """GitHub API helper class using only standard library"""
    
    def __init__(self, token: str, repo: str):
        self.token = token
        self.repo = repo
        self.base_url = f"https://api.github.com/repos/{repo}"
    
    def _request(self, method: str, url: str, data: Optional[dict] = None) -> dict:
        """Make HTTP request to GitHub API"""
        headers = {
            'Authorization': f'token {self.token}',
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        }
        
        if data:
            data = json.dumps(data).encode('utf-8')
        
        req = Request(url, data=data, headers=headers, method=method)
        
        try:
            with urlopen(req) as response:
                return json.loads(response.read().decode('utf-8'))
        except Exception as e:
            print(f"GitHub API request failed: {e}")
            sys.exit(1)
    
    def get_releases(self, per_page: int = 100) -> List[dict]:
        """Get all releases"""
        url = f"{self.base_url}/releases?per_page={per_page}"
        return self._request('GET', url)
    
    def get_release_by_tag(self, tag: str) -> Optional[dict]:
        """Get release by tag"""
        url = f"{self.base_url}/releases/tags/{tag}"
        try:
            return self._request('GET', url)
        except:
            return None
    
    def create_release(self, tag: str, name: str, body: str, 
                      draft: bool = True, prerelease: bool = False,
                      target_commitish: str = "latest") -> dict:
        """Create a new release"""
        url = f"{self.base_url}/releases"
        data = {
            'tag_name': tag,
            'target_commitish': target_commitish,
            'name': name,
            'body': body,
            'draft': draft,
            'prerelease': prerelease
        }
        return self._request('POST', url, data)
    
    def update_release(self, release_id: int, name: Optional[str] = None, 
                      body: Optional[str] = None) -> dict:
        """Update an existing release"""
        url = f"{self.base_url}/releases/{release_id}"
        data = {}
        if name:
            data['name'] = name
        if body:
            data['body'] = body
        return self._request('PATCH', url, data)

class VersionManager:
    """Handle version calculations and comparisons"""
    
    @staticmethod
    def parse_version(version: str) -> Tuple[int, int, int, Optional[str], Optional[int]]:
        """Parse version string into components (major, minor, patch, prerelease, prerelease_num)"""
        # Remove 'v' prefix if present
        version = version.lstrip('v')
        
        # Split on beta/alpha/rc
        match = re.match(r'(\d+)\.(\d+)\.(\d+)(?:-(\w+)\.?(\d+)?)?', version)
        if not match:
            raise ValueError(f"Invalid version format: {version}")
        
        major, minor, patch = int(match.group(1)), int(match.group(2)), int(match.group(3))
        prerelease = match.group(4)
        prerelease_num = int(match.group(5)) if match.group(5) else None
        
        return major, minor, patch, prerelease, prerelease_num
    
    @staticmethod
    def format_version(major: int, minor: int, patch: int, 
                      prerelease: Optional[str] = None, 
                      prerelease_num: Optional[int] = None) -> str:
        """Format version components into string"""
        version = f"v{major}.{minor}.{patch}"
        if prerelease:
            version += f"-{prerelease}"
            if prerelease_num is not None:
                version += f".{prerelease_num}"
        return version
    
    @staticmethod
    def get_next_version(current: str, version_type: str = "patch") -> str:
        """Get next version based on type"""
        major, minor, patch, _, _ = VersionManager.parse_version(current)
        
        if version_type == "major":
            return VersionManager.format_version(major + 1, 0, 0)
        elif version_type == "minor":
            return VersionManager.format_version(major, minor + 1, 0)
        else:  # patch
            return VersionManager.format_version(major, minor, patch + 1)
    
    @staticmethod
    def get_base_version(version: str) -> str:
        """Get base version without prerelease"""
        major, minor, patch, _, _ = VersionManager.parse_version(version)
        return VersionManager.format_version(major, minor, patch)

class ChangelogManager:
    """Handle changelog operations"""
    
    def __init__(self, changelog_path: str = "CHANGELOG.md"):
        self.changelog_path = changelog_path
    
    def read_changelog(self) -> str:
        """Read current changelog content"""
        try:
            with open(self.changelog_path, 'r', encoding='utf-8') as f:
                return f.read()
        except FileNotFoundError:
            return "# Changelog\n\n"
    
    def write_changelog(self, content: str):
        """Write changelog content"""
        with open(self.changelog_path, 'w', encoding='utf-8') as f:
            f.write(content)
    
    def categorize_pr(self, labels: List[str]) -> str:
        """Categorize PR based on labels"""
        for category in CATEGORY_ORDER:
            if category in LABEL_MAPPINGS:
                for label in LABEL_MAPPINGS[category]:
                    if label in labels:
                        return category
        return 'Other Changes'
    
    def format_pr_entry(self, title: str, author: str, number: int) -> str:
        """Format PR entry for changelog"""
        return f"- {title} @{author} [#{number}]"
    
    def add_pr_to_changelog(self, title: str, author: str, number: int, 
                           labels: List[str], target_version: Optional[str] = None) -> bool:
        """Add PR entry to changelog, returns True if changes were made"""
        content = self.read_changelog()
        category = self.categorize_pr(labels)
        entry = self.format_pr_entry(title, author, number)
        
        # Determine target section
        if target_version:
            section_header = f"## [{target_version}]"
        else:
            section_header = "## [Unreleased]"
        
        updated_content = self._add_entry_to_section(content, section_header, category, entry)
        
        if updated_content != content:
            self.write_changelog(updated_content)
            return True
        return False
    
    def _add_entry_to_section(self, content: str, section_header: str, 
                             category: str, entry: str) -> str:
        """Add entry to specific section and category"""
        lines = content.split('\n')
        
        # Find or create the section
        section_start = self._find_section_start(lines, section_header)
        if section_start == -1:
            # Create new section
            return self._create_new_section(content, section_header, category, entry)
        
        # Find or create category within section
        return self._add_entry_to_existing_section(lines, section_start, category, entry)
    
    def _find_section_start(self, lines: List[str], section_header: str) -> int:
        """Find the start line of a section"""
        for i, line in enumerate(lines):
            if line.strip().startswith(section_header.strip()):
                return i
        return -1
    
    def _create_new_section(self, content: str, section_header: str, 
                           category: str, entry: str) -> str:
        """Create a new section with the entry"""
        lines = content.split('\n')
        
        # Find insertion point (after main header, before first release)
        insert_point = 0
        for i, line in enumerate(lines):
            if line.startswith('# '):
                insert_point = i + 1
                break
        
        # Look for first release section to insert before it
        for i in range(insert_point, len(lines)):
            if lines[i].startswith('## ') and '[' in lines[i]:
                insert_point = i
                break
        
        new_section = [
            '',
            section_header,
            '',
            f'### {category}',
            '',
            entry,
            ''
        ]
        
        lines[insert_point:insert_point] = new_section
        return '\n'.join(lines)
    
    def _add_entry_to_existing_section(self, lines: List[str], section_start: int, 
                                      category: str, entry: str) -> str:
        """Add entry to existing section"""
        # Find section boundaries
        section_end = len(lines)
        for i in range(section_start + 1, len(lines)):
            if lines[i].startswith('## '):
                section_end = i
                break
        
        # Find category within section
        category_start = -1
        for i in range(section_start, section_end):
            if lines[i].strip() == f'### {category}':
                category_start = i
                break
        
        if category_start == -1:
            # Create new category before other categories or Full Changelog
            insert_point = section_end
            for i in range(section_start + 1, section_end):
                if lines[i].startswith('### ') or lines[i].startswith('**Full Changelog**'):
                    insert_point = i
                    break
            
            # Insert new category
            new_category = ['', f'### {category}', '', entry]
            if insert_point < len(lines) and lines[insert_point].strip():
                new_category.append('')
            
            lines[insert_point:insert_point] = new_category
        else:
            # Add to existing category (at the beginning)
            insert_point = category_start + 1
            # Skip empty line after category header
            if insert_point < len(lines) and not lines[insert_point].strip():
                insert_point += 1
            
            lines.insert(insert_point, entry)
        
        return '\n'.join(lines)
    
    def convert_unreleased_to_version(self, version: str, date: str, 
                                     repo: str, compare_from: str) -> Optional[str]:
        """Convert [Unreleased] section to versioned section"""
        content = self.read_changelog()
        
        if '## [Unreleased]' not in content:
            return None
        
        # Create version header with link
        version_url = f"https://github.com/{repo}/releases/tag/{version}"
        version_header = f"## [{version}]({version_url}) ({date})"
        
        # Replace Unreleased with version
        updated_content = content.replace('## [Unreleased]', version_header)
        
        # Add Full Changelog link if not present
        lines = updated_content.split('\n')
        updated_lines = []
        in_current_release = False
        
        for i, line in enumerate(lines):
            updated_lines.append(line)
            
            if line == version_header:
                in_current_release = True
            elif in_current_release and line.startswith('## '):
                # End of current release section
                if not any('**Full Changelog**' in prev_line for prev_line in updated_lines[-10:]):
                    # Insert Full Changelog link before next section
                    updated_lines.insert(-1, '')
                    updated_lines.insert(-1, f"**Full Changelog**: https://github.com/{repo}/compare/{compare_from}...{version}")
                    updated_lines.insert(-1, '')
                in_current_release = False
        
        # Handle end of file case
        if in_current_release and not any('**Full Changelog**' in line for line in updated_lines[-5:]):
            updated_lines.extend([
                '',
                f"**Full Changelog**: https://github.com/{repo}/compare/{compare_from}...{version}"
            ])
        
        final_content = '\n'.join(updated_lines)
        
        # Clean up excessive blank lines
        final_content = re.sub(r'\n{3,}', '\n\n', final_content)
        
        if not final_content.endswith('\n'):
            final_content += '\n'
        
        self.write_changelog(final_content)
        return self._extract_release_content(final_content, version)
    
    def _extract_release_content(self, content: str, version: str) -> str:
        """Extract content for a specific version for release body"""
        lines = content.split('\n')
        release_lines = []
        in_target_release = False
        
        for line in lines:
            if line.startswith(f"## [{version}]"):
                in_target_release = True
                continue
            elif in_target_release and line.startswith('## '):
                break
            elif in_target_release and line.strip() and not line.startswith('**Full Changelog**'):
                release_lines.append(line)
        
        if not release_lines:
            return "## Other Changes\n\n_No changes in this release._"
        
        # Convert ### to ## for release format
        release_content = '\n'.join(release_lines)
        release_content = re.sub(r'^### ', '## ', release_content, flags=re.MULTILINE)
        
        return release_content.strip()

class ReleaseManager:
    """Main release management orchestrator"""
    
    def __init__(self, github_token: str, repo: str):
        self.github = GitHubAPI(github_token, repo)
        self.changelog = ChangelogManager()
        self.repo = repo
    
    def handle_pr_merged(self, title: str, author: str, number: int, 
                        labels: List[str], base_branch: str) -> dict:
        """Handle PR merged event"""
        result = {'action': 'pr_merged', 'changes_made': False}
        
        # Check if this is a beta branch
        is_beta = base_branch.startswith('beta')
        
        if is_beta:
            result.update(self._handle_beta_pr_merged(title, author, number, labels))
        else:
            result.update(self._handle_main_pr_merged(title, author, number, labels))
        
        return result
    
    def _handle_beta_pr_merged(self, title: str, author: str, number: int, 
                              labels: List[str]) -> dict:
        """Handle PR merged to beta branch"""
        # Check for existing beta draft
        releases = self.github.get_releases()
        beta_draft = None
        
        for release in releases:
            if (release.get('draft') and release.get('prerelease') and 
                'beta' in release.get('tag_name', '')):
                beta_draft = release
                break
        
        if beta_draft:
            # Add to existing beta draft version
            tag = beta_draft['tag_name']
            changes_made = self.changelog.add_pr_to_changelog(
                title, author, number, labels, tag
            )
            return {'existing_beta_draft': tag, 'changes_made': changes_made}
        else:
            # Add to Unreleased Beta section
            changes_made = self.changelog.add_pr_to_changelog(
                title, author, number, labels, "Unreleased Beta"
            )
            return {'unreleased_beta': True, 'changes_made': changes_made}
    
    def _handle_main_pr_merged(self, title: str, author: str, number: int, 
                              labels: List[str]) -> dict:
        """Handle PR merged to main/latest branch"""
        # Check for existing draft release
        releases = self.github.get_releases()
        draft_release = None
        
        for release in releases:
            if release.get('draft') and not release.get('prerelease'):
                draft_release = release
                break
        
        if draft_release:
            # Add to existing draft version
            tag = draft_release['tag_name']
            changes_made = self.changelog.add_pr_to_changelog(
                title, author, number, labels, tag
            )
            return {'existing_draft': tag, 'changes_made': changes_made}
        else:
            # Add to Unreleased section
            changes_made = self.changelog.add_pr_to_changelog(
                title, author, number, labels
            )
            return {'unreleased': True, 'changes_made': changes_made}
    
    def create_beta_draft(self) -> dict:
        """Create or update beta draft release"""
        # Get latest version for next beta calculation
        releases = self.github.get_releases()
        latest_version = self._get_latest_version(releases)
        
        # Calculate next beta version
        next_beta = self._calculate_next_beta_version(latest_version, releases)
        
        # Check for Unreleased Beta content
        content = self.changelog.read_changelog()
        if '## [Unreleased Beta]' in content:
            # Convert to beta version
            date = datetime.now().strftime('%Y-%m-%d')
            release_content = self.changelog.convert_unreleased_to_version(
                next_beta, date, self.repo, latest_version
            )
        else:
            # Create minimal content
            release_content = "## Other Changes\n\n_No changes in this beta release._"
        
        # Create beta release body
        version_without_v = next_beta.lstrip('v')
        body = f"Beta Release - {version_without_v}\n\n{release_content}\n\n"
        body += f"**Full Changelog**: https://github.com/{self.repo}/compare/{latest_version}...{next_beta}"
        
        # Create draft release
        release = self.github.create_release(
            tag=next_beta,
            name=next_beta,
            body=body,
            draft=True,
            prerelease=True
        )
        
        return {
            'action': 'created_beta_draft',
            'version': next_beta,
            'release_id': release['id']
        }
    
    def _get_latest_version(self, releases: List[dict]) -> str:
        """Get latest non-beta version"""
        for release in releases:
            tag = release.get('tag_name', '')
            if not release.get('prerelease') and 'beta' not in tag:
                return tag
        return 'v0.0.0'
    
    def _calculate_next_beta_version(self, latest_version: str, releases: List[dict]) -> str:
        """Calculate next beta version"""
        # Get base version for next release
        major, minor, patch, _, _ = VersionManager.parse_version(latest_version)
        next_base = VersionManager.format_version(major, minor, patch + 1)
        
        # Check for existing betas with this base
        existing_betas = []
        for release in releases:
            tag = release.get('tag_name', '')
            if tag.startswith(f"{next_base}-beta."):
                try:
                    _, _, _, _, beta_num = VersionManager.parse_version(tag)
                    if beta_num is not None:
                        existing_betas.append(beta_num)
                except:
                    continue
        
        # Get next beta number
        next_beta_num = max(existing_betas, default=-1) + 1
        return VersionManager.format_version(major, minor, patch + 1, 'beta', next_beta_num)

def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(description='Unified Release Manager')
    parser.add_argument('action', choices=[
        'pr-merged', 'create-beta-draft', 'publish-beta', 'convert-to-stable', 'publish-stable'
    ])
    parser.add_argument('--github-token', required=True, help='GitHub token')
    parser.add_argument('--repo', required=True, help='Repository name (owner/repo)')
    
    # PR merged args
    parser.add_argument('--pr-title', help='PR title')
    parser.add_argument('--pr-author', help='PR author')
    parser.add_argument('--pr-number', type=int, help='PR number')
    parser.add_argument('--pr-labels', help='PR labels (JSON array)')
    parser.add_argument('--base-branch', help='Base branch name')
    
    # Version args
    parser.add_argument('--version', help='Version tag')
    parser.add_argument('--release-body', help='Release body content')
    
    args = parser.parse_args()
    
    manager = ReleaseManager(args.github_token, args.repo)
    
    if args.action == 'pr-merged':
        if not all([args.pr_title, args.pr_author, args.pr_number, args.base_branch]):
            print("Error: Missing required PR arguments")
            sys.exit(1)
        
        labels = json.loads(args.pr_labels) if args.pr_labels else []
        result = manager.handle_pr_merged(
            args.pr_title, args.pr_author, args.pr_number, labels, args.base_branch
        )
        print(json.dumps(result))
    
    elif args.action == 'create-beta-draft':
        result = manager.create_beta_draft()
        print(json.dumps(result))
    
    else:
        print(f"Action {args.action} not yet implemented")
        sys.exit(1)

if __name__ == '__main__':
    main()