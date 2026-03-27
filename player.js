

class StreamDirector {
    constructor() {
        this.client = AgoraRTC.createClient({ mode: "live", codec: "vp8" });
        this.tracks = new Map();
        
        // Recording
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.recordingStartTime = 0;
        this.recordingAttempts = 0; // Track retry attempts
        
        // State
        this.screenshareTrack = null;
        this.cameraTrack = null;
        this.mainTrack = null;
        this.pipTrack = null;
        this.audioTracks = new Set();
        this.isLive = true; 
        this.dvrBlobUrl = null;
        this.config = null;

        // UI Refs
        this.ui = {
            liveContainer: document.getElementById('live-video-container'),
            dvrPlayer: document.getElementById('dvr-video-player'),
            // PiP elements now live in the sidebar
            pipWindow: document.querySelector('.sidebar #pip-window') || document.getElementById('pip-window'),
            pipContainer: document.querySelector('.sidebar #pip-video-container') || document.getElementById('pip-video-container'),
            pipLabel: document.querySelector('.sidebar #pip-label') || document.getElementById('pip-label'),
            status: document.getElementById('connection-status'),
            recordingStatus: document.getElementById('recording-status'),
            bufferSize: document.getElementById('buffer-size'),
            btnDownload: document.getElementById('btn-download'),
            btnPopout: document.getElementById('btn-popout'),
            configStatus: document.getElementById('config-status'),
            
            // Unified Controls
            timelineFill: document.getElementById('timeline-fill'),
            timelineInput: document.getElementById('timeline-slider'),
            playPauseBtn: document.getElementById('play-pause-btn'),
            timeDisplay: document.getElementById('time-display'),
            liveBadge: document.getElementById('live-badge')
        };

        this.bindEvents();
        
        // Auto-Start
        this.autoConfigure();
        
        // Update loop
        setInterval(() => this.updateUI(), 500);
    }

    bindEvents() {
        this.ui.timelineInput.addEventListener('input', (e) => this.handleSeek(e.target.value));
        this.ui.playPauseBtn.addEventListener('click', () => this.togglePlayPause());
        this.ui.btnDownload.addEventListener('click', () => this.downloadRecording());
        this.ui.liveBadge.addEventListener('click', () => this.jumpToLive());
        
        // Sync button state with actual video play/pause events
        this.ui.dvrPlayer.addEventListener('play', () => {
            if (!this.isLive) {
                this.ui.playPauseBtn.textContent = '⏸';
            }
        });
        
        this.ui.dvrPlayer.addEventListener('pause', () => {
            if (!this.isLive) {
                this.ui.playPauseBtn.textContent = '▶';
            }
        });
        
        this.ui.dvrPlayer.addEventListener('ended', () => {
            this.ui.playPauseBtn.textContent = '▶';
        });

        // Keyboard Shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Space') {
                e.preventDefault(); 
                this.togglePlayPause();
            }
            if (e.code === 'ArrowLeft') {
                e.preventDefault();
                this.stepSeek(-5);
            }
            if (e.code === 'ArrowRight') {
                e.preventDefault();
                this.stepSeek(5);
            }
        });

    }

    // --- Auto Configuration Logic ---

    async autoConfigure() {
        try {
            this.ui.configStatus.textContent = "Fetching Events...";
            
            // 1. Fetch Events to get Slug
            console.log("Fetching events from Scaler...");
            const eventsRes = await fetch('https://www.scaler.com/academy/mentee/events');
            if (!eventsRes.ok) throw new Error("Failed to fetch events: " + eventsRes.status);
            
            const eventsData = await eventsRes.json();
            console.log("Events API Response:", eventsData); // DEBUG: Check structure
            
            // Fix: Use 'meeting_slug' (underscore) not 'meeting-slug' (hyphen)
            const slug = eventsData.futureEvents?.[0]?.meeting_slug || eventsData.topCardEvent?.meeting_slug;
            
            // Backup: Check if it's nested differently or under 'events' array
            if (!slug) {
                console.warn("slug not found in topCardEvent. Checking alternatives...");
                // Add logic here if we find it elsewhere in the log
            }

            if (!slug) throw new Error("No active meeting found. Check console for API response.");

            this.ui.configStatus.textContent = "Fetching Session...";

            // 2. Fetch Live Session for Credentials
            const sessionRes = await fetch(`https://www.scaler.com/meetings/${slug}/live-session`);
            if (!sessionRes.ok) throw new Error("Failed to fetch live session");
            const sessionData = await sessionRes.json();
            
            console.log("Session API Response:", sessionData); // DEBUG: Check structure

            // 3. Extract Data
            // Fix: Convert item_id to string for Agora
            const rawChannel = sessionData.data?.feedback_forms?.[0]?.item_id;
            const channel = rawChannel ? String(rawChannel) : null;
            const token = sessionData.tokens?.video_broadcasting;
            const participants = sessionData.participants || [];
            
            // Extract UID logic: Last participant + prefix
            let uid = null;
            if (participants.length > 0) {
                const lastId = participants[participants.length - 1].user_id;
                uid = parseInt(`1${lastId}`); // Prepend 1
            }

            if (!channel || !token || !uid) throw new Error("Incomplete credentials");

            this.config = { appId: "03d2d4319a52428ea2e5068d87f3bca9", channel, token, uid };
            this.ui.configStatus.textContent = `Channel: ${channel}`;
            
            // Start Agora
            this.initAgora();

        } catch (err) {
            console.error(err);
            this.ui.configStatus.textContent = "Config Error: " + err.message;
            this.ui.status.textContent = "Auth Failed";
            this.ui.status.style.color = "var(--danger-color)";
        }
    }

    // --- Agora Logic ---

    async initAgora() {
        this.client.setClientRole("audience");
        this.client.on("user-published", this.handleUserPublished.bind(this));
        this.client.on("user-unpublished", this.handleUserUnpublished.bind(this));

        try {
            await this.client.join(this.config.appId, this.config.channel, this.config.token, this.config.uid);
            this.ui.status.textContent = "Connected";
            this.ui.status.style.color = "var(--success-color)";
        } catch (error) {
            console.error(error);
            this.ui.status.textContent = "Connection Error";
            this.ui.status.style.color = "var(--danger-color)";
        }
    }

    async handleUserPublished(user, mediaType) {
        await this.client.subscribe(user, mediaType);

        if (mediaType === "audio") {
            user.audioTrack.play();
            this.audioTracks.add(user.audioTrack);
            // Restart recording to include new audio track
            this.manageRecording();
        }

        if (mediaType === "video") {
            const type = this.detectStreamType(user.uid);
            const trackInfo = { uid: user.uid, track: user.videoTrack, type };
            this.tracks.set(user.uid, trackInfo);

            if (type === 'screenshare') this.screenshareTrack = trackInfo;
            else if (type === 'camera') this.cameraTrack = trackInfo;

            this.updateLayout();
            // Delay recording start to allow audio tracks to arrive
            setTimeout(() => this.manageRecording(), 500);
        }
    }

    handleUserUnpublished(user, mediaType) {
        if (mediaType === "video") {
            this.tracks.delete(user.uid);
            if (this.screenshareTrack?.uid === user.uid) this.screenshareTrack = null;
            if (this.cameraTrack?.uid === user.uid) this.cameraTrack = null;
            this.updateLayout();
        }
        if (mediaType === "audio") {
            this.audioTracks.delete(user.audioTrack);
        }
    }

    detectStreamType(uid) {
        const str = uid.toString();
        if (str.startsWith('2')) return 'screenshare';
        if (str.startsWith('1')) return 'camera';
        return 'unknown';
    }

    // --- Layout Logic ---

    updateLayout() {
        let newMain = this.screenshareTrack || this.cameraTrack || this.tracks.values().next().value;
        let newPiP = null;

        // Always show camera in sidebar PiP if it exists
        if (this.screenshareTrack && this.cameraTrack) {
            // Both exist: screenshare on main, camera in PiP
            newMain = this.screenshareTrack;
            newPiP = this.cameraTrack;
        } else if (this.cameraTrack && !this.screenshareTrack) {
            // Only camera: keep camera on main AND in PiP for monitoring
            newMain = this.cameraTrack;
            newPiP = this.cameraTrack;
        } else if (this.screenshareTrack && !this.cameraTrack) {
            // Only screenshare: screenshare on main, no PiP
            newMain = this.screenshareTrack;
            newPiP = null;
        }

        if (this.isLive) {
            this.renderTrack(newMain, this.ui.liveContainer);
        }
        
        if (newPiP) {
            // Ensure PiP element exists in the sidebar; fall back if missing
            if (this.ui.pipWindow) this.ui.pipWindow.style.display = 'block';
            if (this.ui.pipContainer) this.renderTrack(newPiP, this.ui.pipContainer);
            if (this.ui.pipLabel) this.ui.pipLabel.textContent = `Camera: ${newPiP.uid}`;
        } else {
            if (this.ui.pipWindow) this.ui.pipWindow.style.display = 'none';
        }

        this.mainTrack = newMain;
        this.pipTrack = newPiP;
    }

    renderTrack(trackInfo, container) {
        if (!trackInfo) return;
        if (trackInfo.track.isPlaying) trackInfo.track.stop();
        trackInfo.track.play(container);
    }



    // --- Recording & DVR ---

    manageRecording() {
        const target = this.screenshareTrack || this.cameraTrack;
        if (!target) {
            console.log('No video track available for recording');
            if (this.ui.recordingStatus) {
                this.ui.recordingStatus.textContent = 'No Video';
                this.ui.recordingStatus.style.color = 'var(--text-secondary)';
            }
            return;
        }

        if (this.mediaRecorder) {
            // Same track, same state - no need to restart
            if (this.mediaRecorder._trackUid === target.uid && this.mediaRecorder.state === 'recording') {
                console.log('Already recording this track');
                return;
            }
            // Different track or stopped - restart
            console.log('Stopping existing recorder to start new one');
            if (this.mediaRecorder.state !== 'inactive') {
                this.mediaRecorder.stop();
            }
            setTimeout(() => this.startRecording(target), 150);
        } else {
            this.startRecording(target);
        }
    }

    startRecording(trackInfo) {
        try {
            console.log(`Attempting to start recording: ${trackInfo.type} (uid: ${trackInfo.uid})`);
            
            if (this.ui.recordingStatus) {
                this.ui.recordingStatus.textContent = 'Starting...';
                this.ui.recordingStatus.style.color = '#fbbf24'; // amber
            }
            
            const stream = new MediaStream();
            const videoMediaTrack = trackInfo.track.getMediaStreamTrack();
            
            if (!videoMediaTrack) {
                console.error('Failed to get video MediaStreamTrack');
                if (this.ui.recordingStatus) {
                    this.ui.recordingStatus.textContent = 'Failed';
                    this.ui.recordingStatus.style.color = 'var(--danger-color)';
                }
                return;
            }
            
            stream.addTrack(videoMediaTrack);
            console.log(`Added video track, readyState: ${videoMediaTrack.readyState}`);
            
            // Add audio tracks
            let audioCount = 0;
            this.audioTracks.forEach(t => {
                const audioMediaTrack = t.getMediaStreamTrack();
                if (audioMediaTrack && audioMediaTrack.readyState === 'live') {
                    stream.addTrack(audioMediaTrack);
                    audioCount++;
                }
            });
            console.log(`Added ${audioCount} audio track(s)`);

            // Check browser support for codec
            const mimeType = 'video/webm; codecs=vp8,opus';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                console.warn(`${mimeType} not supported, trying fallback`);
                this.mediaRecorder = new MediaRecorder(stream);
            } else {
                this.mediaRecorder = new MediaRecorder(stream, { mimeType });
            }
            
            this.mediaRecorder._trackUid = trackInfo.uid;

            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    this.recordedChunks.push(e.data);
                }
            };

            this.mediaRecorder.onerror = (e) => {
                console.error('MediaRecorder error:', e);
                if (this.ui.recordingStatus) {
                    this.ui.recordingStatus.textContent = 'Error';
                    this.ui.recordingStatus.style.color = 'var(--danger-color)';
                }
            };

            this.mediaRecorder.onstart = () => {
                console.log('MediaRecorder started successfully');
                this.recordingStartTime = Date.now();
                this.ui.btnDownload.disabled = false;
                if (this.ui.recordingStatus) {
                    this.ui.recordingStatus.textContent = 'Recording';
                    this.ui.recordingStatus.style.color = 'var(--success-color)';
                }
            };

            this.mediaRecorder.start(1000);
            console.log(`MediaRecorder.start() called, state: ${this.mediaRecorder.state}`);
            
        } catch (error) {
            console.error('Failed to start recording:', error);
            if (this.ui.recordingStatus) {
                this.ui.recordingStatus.textContent = 'Failed';
                this.ui.recordingStatus.style.color = 'var(--danger-color)';
            }
        }
    }

    // --- Unified Player Logic ---

    stepSeek(seconds) {
        let currentTime;
        let duration;

        if (this.isLive) {
            duration = (Date.now() - this.recordingStartTime) / 1000;
            currentTime = duration;
        } else {
            const video = this.ui.dvrPlayer;
            if (!video.duration || !isFinite(video.duration)) {
                duration = (Date.now() - this.recordingStartTime) / 1000;
            } else {
                duration = video.duration;
            }
            currentTime = video.currentTime;
        }

        let newTime = currentTime + seconds;
        if (newTime < 0) newTime = 0;
        
        if (newTime >= duration - 0.5) { 
            this.jumpToLive();
            return;
        }

        if (this.isLive) {
            this.enableDVRMode(newTime, true);
        } else {
            this.ui.dvrPlayer.currentTime = newTime;
        }
    }

    enableDVRMode(seekToTime = null, shouldPlay = true) {
        if (this.recordedChunks.length === 0) return;
        
        const blob = new Blob(this.recordedChunks, { type: "video/webm" });
        if (this.dvrBlobUrl) URL.revokeObjectURL(this.dvrBlobUrl);
        this.dvrBlobUrl = URL.createObjectURL(blob);
        
        const video = this.ui.dvrPlayer;
        
        video.onloadedmetadata = () => {
            this.isLive = false;
            this.ui.liveBadge.classList.remove('is-live');
            
            let targetTime = seekToTime;
            if (targetTime === null) {
                targetTime = Math.max(0, video.duration - 0.1); 
            }
            
            video.currentTime = targetTime;
            
            if (shouldPlay) {
                video.play().catch(e => console.warn("Auto-play blocked", e));
                // Button state will be updated by 'play' event listener
            } else {
                video.pause();
                // Button state will be updated by 'pause' event listener
            }

            this.ui.liveContainer.style.display = 'none';
            this.ui.dvrPlayer.style.display = 'block';
            
            this.audioTracks.forEach(t => t.setVolume(0));
            video.onloadedmetadata = null;
        };

        video.src = this.dvrBlobUrl;
    }

    jumpToLive() {
        if (this.isLive) return;
        this.isLive = true;

        this.ui.dvrPlayer.style.display = 'none';
        this.ui.liveContainer.style.display = 'block';
        this.ui.liveBadge.classList.add('is-live');
        
        // Always show pause icon in live mode (live is always "playing")
        this.ui.playPauseBtn.textContent = '⏸';

        this.audioTracks.forEach(t => t.setVolume(100));
        
        if (this.mainTrack) {
            this.mainTrack.track.play(this.ui.liveContainer);
        }
    }

    togglePlayPause() {
        if (this.isLive) {
            this.enableDVRMode(null, false);
        } else {
            if (this.ui.dvrPlayer.paused) {
                this.ui.dvrPlayer.play();
                // Button state will be updated by 'play' event listener
            } else {
                this.ui.dvrPlayer.pause();
                // Button state will be updated by 'pause' event listener
            }
        }
    }

    updateUI() {
        const size = new Blob(this.recordedChunks).size / 1024 / 1024;
        this.ui.bufferSize.textContent = `${size.toFixed(1)} MB`;

        if (this.isLive) {
            this.ui.timelineInput.value = 100;
            this.ui.timelineFill.style.width = '100%';
            const duration = (Date.now() - this.recordingStartTime) / 1000;
            this.ui.timeDisplay.textContent = this.formatTime(duration);
        } else {
            const video = this.ui.dvrPlayer;
            if (!video.duration) return;
            const pct = (video.currentTime / video.duration) * 100;
            this.ui.timelineInput.value = pct;
            this.ui.timelineFill.style.width = `${pct}%`;
            this.ui.timeDisplay.textContent = `${this.formatTime(video.currentTime)} / ${this.formatTime(video.duration)}`;
        }
    }

    handleSeek(value) {
        const pct = parseFloat(value);
        if (pct >= 99) {
            this.jumpToLive();
            return;
        }
        if (this.isLive) {
            this.enableDVRMode();
        }
        const video = this.ui.dvrPlayer;
        if (video.duration && isFinite(video.duration)) {
            const time = (pct / 100) * video.duration;
            video.currentTime = time;
        }
    }

    downloadRecording() {
        if (this.mediaRecorder) this.mediaRecorder.requestData();
        const blob = new Blob(this.recordedChunks, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.style.display = "none";
        a.href = url;
        a.download = `recording_${Date.now()}.webm`;
        document.body.appendChild(a);
        a.click();
    }

    formatTime(seconds) {
        if (!seconds || !isFinite(seconds)) return "00:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
}

// Start App
const app = new StreamDirector();
