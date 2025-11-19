// Global variables
let currentTranscript = '';
let currentSummary = '';
let currentJobId = null;
let eventSource = null;

// --- Helpers ---

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Very small markdown renderer for headings, paragraphs and bullet lists
function renderSummaryMarkdown(markdown) {
    if (!markdown) return '';

    const lines = markdown.split('\n');
    const htmlParts = [];
    let inList = false;

    for (let rawLine of lines) {
        const line = rawLine.trimEnd();

        // Blank line
        if (!line.trim()) {
            if (inList) {
                htmlParts.push('</ul>');
                inList = false;
            }
            htmlParts.push('<br>');
            continue;
        }

        // Headings
        if (line.startsWith('### ')) {
            if (inList) {
                htmlParts.push('</ul>');
                inList = false;
            }
            const content = escapeHtml(line.slice(4).trim());
            htmlParts.push(`<h3>${content}</h3>`);
            continue;
        }

        if (line.startsWith('## ')) {
            if (inList) {
                htmlParts.push('</ul>');
                inList = false;
            }
            const content = escapeHtml(line.slice(3).trim());
            htmlParts.push(`<h2>${content}</h2>`);
            continue;
        }

        // Bullet list
        if (line.startsWith('- ')) {
            const content = escapeHtml(line.slice(2).trim());
            if (!inList) {
                htmlParts.push('<ul>');
                inList = true;
            }
            htmlParts.push(`<li>${content}</li>`);
            continue;
        }

        // Regular paragraph
        if (inList) {
            htmlParts.push('</ul>');
            inList = false;
        }
        htmlParts.push(`<p>${escapeHtml(line.trim())}</p>`);
    }

    if (inList) {
        htmlParts.push('</ul>');
    }

    return htmlParts.join('\n');
}

// Show/hide sections
function showSection(sectionId) {
    const sections = ['inputSection', 'progressSection', 'errorSection', 'resultSection'];
    sections.forEach(id => {
        document.getElementById(id).classList.add('hidden');
    });
    if (sectionId) {
        document.getElementById(sectionId).classList.remove('hidden');
    }
}

// Validate Spotify URL
function isValidSpotifyUrl(url) {
    const spotifyPattern = /^https?:\/\/open\.spotify\.com\/episode\/[a-zA-Z0-9]+/;
    return spotifyPattern.test(url);
}

// Update progress step
function updateProgressStep(stepId, state, percentage, message) {
    const step = document.getElementById(`step-${stepId}`);
    if (!step) return;

    const icon = step.querySelector('.step-icon');
    const messageEl = step.querySelector('.step-message');
    const progressBar = step.querySelector('.progress-bar');

    // Update state classes
    step.classList.remove('active', 'completed');
    if (state === 'active') {
        step.classList.add('active');
    } else if (state === 'completed') {
        step.classList.add('completed');
        icon.textContent = '✓';
    }

    // Update message
    if (message) {
        messageEl.textContent = message;
    }

    // Update progress bar
    if (progressBar && percentage !== undefined) {
        progressBar.style.width = `${percentage}%`;
    }
}

// Reset all progress steps
function resetProgressSteps() {
    const steps = document.querySelectorAll('.progress-step');
    steps.forEach((step, index) => {
        step.classList.remove('active', 'completed');
        const icon = step.querySelector('.step-icon');
        if (step.id !== 'step-complete') {
            icon.textContent = index + 1;
        }
        const progressBar = step.querySelector('.progress-bar');
        if (progressBar) {
            progressBar.style.width = '0%';
        }
    });
}

// Handle progress updates from SSE
function handleProgressUpdate(progress) {
    // Map backend step names to frontend step IDs
    const stepMapping = {
        'metadata': 'metadata',
        'rss': 'rss',
        'parse': 'parse',
        'download': 'download',
        'compress': 'compress',
        'splitting': 'compress', // Splitting also uses compress step
        'transcribe': 'transcribe',
        'merge': 'transcribe', // Merging also uses transcribe step
        'summary': 'summary',
        'complete': 'complete',
        'error': 'error'
    };

    // Update each step based on progress
    Object.keys(progress).forEach(stepName => {
        if (stepName === 'complete' || stepName === 'result') return;

        const stepData = progress[stepName];
        const frontendStepId = stepMapping[stepName];

        if (frontendStepId && stepData) {
            const { percentage, message } = stepData;

            if (percentage === 100) {
                updateProgressStep(frontendStepId, 'completed', percentage, message);
            } else if (percentage > 0) {
                updateProgressStep(frontendStepId, 'active', percentage, message);
            }
        }
    });

    // Check if complete
    if (progress.complete && currentJobId) {
        console.log('Transcription and summary complete');
        updateProgressStep('complete', 'completed', 100, 'Transcript and summary ready!');

        // Fetch final result
        setTimeout(() => fetchResult(currentJobId), 500);
    }

    // Check for errors
    if (progress.error) {
        const errorData = progress.error;
        showError(errorData.message || 'An error occurred during transcription');

        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
    }
}

// Start progress monitoring via SSE
function startProgressMonitoring(jobId) {
    currentJobId = jobId;

    // Close existing connection if any
    if (eventSource) {
        eventSource.close();
    }

    // Create new EventSource for SSE
    eventSource = new EventSource(`/api/progress/${jobId}`);

    eventSource.onmessage = (event) => {
        try {
            const progress = JSON.parse(event.data);

            if (progress.status === 'connected') {
                console.log('Connected to progress stream');
                return;
            }

            handleProgressUpdate(progress);
        } catch (error) {
            console.error('Error parsing progress data:', error);
        }
    };

    eventSource.onerror = (error) => {
        console.error('EventSource error:', error);
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
    };
}

// Fetch final result
async function fetchResult(jobId) {
    try {
        const response = await fetch(`/api/result/${jobId}`);
        const data = await response.json();

        if (response.ok && data.success) {
            displayResults(data);
        } else if (response.status === 202) {
            // Still processing, wait a bit
            setTimeout(() => fetchResult(jobId), 2000);
        } else {
            showError(data.error || 'Failed to fetch result');
        }
    } catch (error) {
        console.error('Error fetching result:', error);
        showError(error.message);
    }
}

// Main transcription function
async function transcribeEpisode() {
    const urlInput = document.getElementById('spotifyUrl');
    const rssInput = document.getElementById('rssUrl');
    const spotifyUrl = urlInput.value.trim();
    const rssUrl = rssInput.value.trim();
    const transcribeBtn = document.getElementById('transcribeBtn');

    // Reset visual error state
    urlInput.classList.remove('input-error');

    // Validate URL
    if (!spotifyUrl) {
        urlInput.classList.add('input-error');
        showError('Please enter a Spotify podcast episode URL');
        return;
    }

    if (!isValidSpotifyUrl(spotifyUrl)) {
        urlInput.classList.add('input-error');
        showError('Please enter a valid Spotify episode URL (e.g., https://open.spotify.com/episode/...)');
        return;
    }

    // Disable button and reset UI
    transcribeBtn.disabled = true;
    transcribeBtn.textContent = 'Processing...';
    resetProgressSteps();
    showSection('progressSection');

    // Prime summary UI
    const summaryEl = document.getElementById('summaryText');
    if (summaryEl) {
        summaryEl.textContent = 'Generating summary with Gemini...';
        summaryEl.classList.add('summary-empty');
    }

    try {
        // Make API request to start transcription
        const response = await fetch('/api/transcript', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ spotifyUrl, rssUrl: rssUrl || undefined })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to start transcription');
        }

        // Start monitoring progress
        if (data.jobId) {
            startProgressMonitoring(data.jobId);
        } else {
            throw new Error('No job ID returned from server');
        }

    } catch (error) {
        console.error('Error:', error);
        showError(error.message);
    } finally {
        // Re-enable button
        transcribeBtn.disabled = false;
        transcribeBtn.textContent = 'Get Transcript';
    }
}

// Display results
function displayResults(data) {
    // Set episode info
    document.getElementById('episodeTitle').textContent = data.episode.title;

    const episodeDate = new Date(data.episode.published).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    document.getElementById('episodeDate').textContent = `Published: ${episodeDate}`;

    const durationEl = document.getElementById('episodeDuration');
    if (data.episode.duration) {
        durationEl.textContent = `Duration: ${data.episode.duration}`;
    } else {
        durationEl.textContent = '';
    }

    // Set transcript
    currentTranscript = data.transcript;
    document.getElementById('transcriptText').textContent = data.transcript;

    // Set summary (if available)
    const summaryEl = document.getElementById('summaryText');
    if (summaryEl) {
        if (data.summary) {
            currentSummary = data.summary;
            summaryEl.innerHTML = renderSummaryMarkdown(data.summary);
            summaryEl.classList.remove('summary-empty');
        } else {
            currentSummary = '';
            summaryEl.textContent = 'Summary unavailable. You can still read the full transcript below.';
            summaryEl.classList.add('summary-empty');
        }
    }

    // Show result section
    showSection('resultSection');

    // Scroll to results
    document.getElementById('resultSection').scrollIntoView({ behavior: 'smooth' });

    // Close SSE connection
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
}

// Show error message
function showError(message) {
    document.getElementById('errorMessage').textContent = message;
    showSection('errorSection');

    // Close SSE connection
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
}

// Copy transcript to clipboard
async function copyTranscript() {
    try {
        await navigator.clipboard.writeText(currentTranscript);

        // Show feedback
        const copyBtn = document.querySelector('.copy-btn');
        const originalText = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        copyBtn.style.background = '#10b981';

        setTimeout(() => {
            copyBtn.textContent = originalText;
            copyBtn.style.background = '';
        }, 2000);
    } catch (error) {
        console.error('Failed to copy:', error);
        alert('Failed to copy transcript. Please select and copy manually.');
    }
}

// Copy summary to clipboard
async function copySummary() {
    try {
        const textToCopy = currentSummary || document.getElementById('summaryText')?.textContent || '';
        if (!textToCopy.trim()) return;

        await navigator.clipboard.writeText(textToCopy);

        const copyBtn = document.querySelector('.summary-container .copy-btn');
        if (!copyBtn) return;

        const originalText = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        copyBtn.style.background = '#10b981';
        copyBtn.style.color = '#ffffff';

        setTimeout(() => {
            copyBtn.textContent = originalText;
            copyBtn.style.background = '';
            copyBtn.style.color = '';
        }, 2000);
    } catch (error) {
        console.error('Failed to copy summary:', error);
        alert('Failed to copy summary. Please select and copy manually.');
    }
}

// Allow Enter key to submit
document.getElementById('spotifyUrl').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        transcribeEpisode();
    }
});

document.getElementById('rssUrl').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        transcribeEpisode();
    }
});

// Check server health on load
window.addEventListener('load', async () => {
    try {
        const response = await fetch('/api/health');
        const data = await response.json();
        console.log('Server status:', data.status);
    } catch (error) {
        console.error('Server health check failed:', error);
        showError('Cannot connect to server. Please make sure the server is running.');
    }
});

// Clean up on page unload
window.addEventListener('beforeunload', () => {
    if (eventSource) {
        eventSource.close();
    }
});

// =========================================================================
// IndexedDB Integration Functions
// =========================================================================

let currentEpisodeData = null;
let currentSpotifyUrl = '';

// Intercept transcribeEpisode to save URL
const originalTranscribeEpisode = transcribeEpisode;
window.transcribeEpisode = async function() {
    const urlInput = document.getElementById('spotifyUrl');
    currentSpotifyUrl = urlInput.value.trim();
    return originalTranscribeEpisode();
};

// Intercept displayResults to save episode data
const originalDisplayResults = displayResults;
window.displayResults = function(data) {
    currentEpisodeData = data.episode;
    currentSpotifyUrl = currentSpotifyUrl || '';
    return originalDisplayResults(data);
};

// Save to IndexedDB
async function saveToLocal() {
    if (!currentEpisodeData || !currentTranscript) {
        alert('No transcript to save');
        return;
    }

    try {
        const data = {
            episode: currentEpisodeData,
            transcript: currentTranscript,
            summary: currentSummary,
            spotifyUrl: currentSpotifyUrl
        };

        await transcriptDB.saveTranscript(data);

        // Show feedback
        const saveBtn = document.getElementById('saveBtn');
        const originalText = saveBtn.innerHTML;
        saveBtn.innerHTML = '✓ Saved!';
        saveBtn.style.background = '#10b981';
        saveBtn.style.color = '#ffffff';

        setTimeout(() => {
            saveBtn.innerHTML = originalText;
            saveBtn.style.background = '';
            saveBtn.style.color = '';
        }, 2000);
    } catch (error) {
        console.error('Failed to save:', error);
        alert('Failed to save transcript to local storage');
    }
}

// Show saved transcripts
async function showSavedTranscripts() {
    try {
        const transcripts = await transcriptDB.getAllTranscripts();
        const listContainer = document.getElementById('savedTranscriptsList');

        if (transcripts.length === 0) {
            listContainer.innerHTML = '<p class="no-transcripts">No saved transcripts yet. Save a transcript to see it here!</p>';
        } else {
            listContainer.innerHTML = transcripts.map(t => `
                <div class="saved-item" data-id="${t.id}">
                    <div class="saved-item-header">
                        <h4>${escapeHtml(t.episodeTitle)}</h4>
                        <button onclick="deleteSavedTranscript(${t.id})" class="delete-btn" title="Delete">🗑️</button>
                    </div>
                    <div class="saved-item-meta">
                        <span>📅 ${new Date(t.timestamp).toLocaleDateString()}</span>
                        ${t.episodeDuration ? `<span>⏱️ ${escapeHtml(t.episodeDuration)}</span>` : ''}
                    </div>
                    <div class="saved-item-preview">
                        ${escapeHtml(t.transcript.substring(0, 150))}...
                    </div>
                    <div class="saved-item-actions">
                        <button onclick="loadSavedTranscript(${t.id})" class="load-btn">📖 View</button>
                        <button onclick="exportSingleTranscript(${t.id})" class="export-single-btn">📄 Export</button>
                    </div>
                </div>
            `).join('');
        }

        document.getElementById('savedTranscriptsSection').classList.remove('hidden');
    } catch (error) {
        console.error('Failed to load saved transcripts:', error);
        alert('Failed to load saved transcripts');
    }
}

// Close saved transcripts view
function closeSavedTranscripts() {
    document.getElementById('savedTranscriptsSection').classList.add('hidden');
}

// Load saved transcript
async function loadSavedTranscript(id) {
    try {
        const transcript = await transcriptDB.getTranscript(id);
        if (transcript) {
            currentEpisodeData = {
                title: transcript.episodeTitle,
                published: transcript.episodeDate,
                duration: transcript.episodeDuration
            };
            currentSpotifyUrl = transcript.spotifyUrl || '';

            displayResults({
                episode: currentEpisodeData,
                transcript: transcript.transcript,
                summary: transcript.summary
            });

            closeSavedTranscripts();

            // Scroll to top
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    } catch (error) {
        console.error('Failed to load transcript:', error);
        alert('Failed to load transcript');
    }
}

// Delete saved transcript
async function deleteSavedTranscript(id) {
    if (!confirm('Are you sure you want to delete this transcript?')) {
        return;
    }

    try {
        await transcriptDB.deleteTranscript(id);
        showSavedTranscripts(); // Refresh the list
    } catch (error) {
        console.error('Failed to delete transcript:', error);
        alert('Failed to delete transcript');
    }
}

// Export single transcript as JSON
async function exportSingleTranscript(id) {
    try {
        const transcript = await transcriptDB.getTranscript(id);
        if (transcript) {
            const dataStr = JSON.stringify(transcript, null, 2);
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(dataBlob);
            const link = document.createElement('a');
            link.href = url;
            const filename = transcript.episodeTitle.replace(/[^a-z0-9]/gi, '-').toLowerCase();
            link.download = `transcript-${filename}-${Date.now()}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }
    } catch (error) {
        console.error('Failed to export transcript:', error);
        alert('Failed to export transcript');
    }
}

// Export all transcripts
async function exportAllTranscripts() {
    try {
        const count = await transcriptDB.exportAsJSON();
        alert(`Exported ${count} transcript(s) successfully!`);
    } catch (error) {
        console.error('Failed to export transcripts:', error);
        alert('Failed to export transcripts');
    }
}
