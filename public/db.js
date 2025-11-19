// IndexedDB Manager for Podcast Transcripts
class TranscriptDB {
    constructor() {
        this.dbName = 'PodcastTranscriptsDB';
        this.dbVersion = 1;
        this.storeName = 'transcripts';
        this.db = null;
    }

    // Initialize database
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => {
                console.error('IndexedDB error:', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                console.log('IndexedDB initialized successfully');
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create object store if it doesn't exist
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const objectStore = db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });

                    // Create indexes
                    objectStore.createIndex('episodeTitle', 'episodeTitle', { unique: false });
                    objectStore.createIndex('timestamp', 'timestamp', { unique: false });
                    objectStore.createIndex('spotifyUrl', 'spotifyUrl', { unique: false });

                    console.log('Object store created successfully');
                }
            };
        });
    }

    // Save transcript
    async saveTranscript(data) {
        if (!this.db) {
            await this.init();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const objectStore = transaction.objectStore(this.storeName);

            const transcriptData = {
                episodeTitle: data.episode.title,
                episodeDate: data.episode.published,
                episodeDuration: data.episode.duration,
                transcript: data.transcript,
                summary: data.summary || null,
                spotifyUrl: data.spotifyUrl || null,
                timestamp: Date.now(),
                dateAdded: new Date().toISOString()
            };

            const request = objectStore.add(transcriptData);

            request.onsuccess = () => {
                console.log('Transcript saved to IndexedDB with ID:', request.result);
                resolve(request.result);
            };

            request.onerror = () => {
                console.error('Error saving transcript:', request.error);
                reject(request.error);
            };
        });
    }

    // Get all transcripts
    async getAllTranscripts() {
        if (!this.db) {
            await this.init();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const objectStore = transaction.objectStore(this.storeName);
            const request = objectStore.getAll();

            request.onsuccess = () => {
                // Sort by timestamp (newest first)
                const transcripts = request.result.sort((a, b) => b.timestamp - a.timestamp);
                resolve(transcripts);
            };

            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    // Get single transcript by ID
    async getTranscript(id) {
        if (!this.db) {
            await this.init();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const objectStore = transaction.objectStore(this.storeName);
            const request = objectStore.get(id);

            request.onsuccess = () => {
                resolve(request.result);
            };

            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    // Delete transcript by ID
    async deleteTranscript(id) {
        if (!this.db) {
            await this.init();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const objectStore = transaction.objectStore(this.storeName);
            const request = objectStore.delete(id);

            request.onsuccess = () => {
                console.log('Transcript deleted from IndexedDB');
                resolve();
            };

            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    // Search transcripts by episode title
    async searchByTitle(searchTerm) {
        if (!this.db) {
            await this.init();
        }

        const allTranscripts = await this.getAllTranscripts();
        return allTranscripts.filter(transcript =>
            transcript.episodeTitle.toLowerCase().includes(searchTerm.toLowerCase())
        );
    }

    // Clear all transcripts
    async clearAll() {
        if (!this.db) {
            await this.init();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const objectStore = transaction.objectStore(this.storeName);
            const request = objectStore.clear();

            request.onsuccess = () => {
                console.log('All transcripts cleared from IndexedDB');
                resolve();
            };

            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    // Export all transcripts as JSON
    async exportAsJSON() {
        const transcripts = await this.getAllTranscripts();
        const dataStr = JSON.stringify(transcripts, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });

        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `podcast-transcripts-${Date.now()}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        return transcripts.length;
    }

    // Get database statistics
    async getStats() {
        const transcripts = await this.getAllTranscripts();
        return {
            totalTranscripts: transcripts.length,
            totalSize: new Blob([JSON.stringify(transcripts)]).size,
            oldestDate: transcripts.length > 0 ? new Date(transcripts[transcripts.length - 1].timestamp) : null,
            newestDate: transcripts.length > 0 ? new Date(transcripts[0].timestamp) : null
        };
    }
}

// Initialize global instance
const transcriptDB = new TranscriptDB();

// Initialize on load
window.addEventListener('load', async () => {
    try {
        await transcriptDB.init();
    } catch (error) {
        console.error('Failed to initialize IndexedDB:', error);
    }
});
