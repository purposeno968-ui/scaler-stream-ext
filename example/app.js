// fixed for scaler
const APP_ID = "03d2d4319a52428ea2e5068d87f3bca9";
// get the  channel , token , uid see readme.md
const CHANNEL = "";
const TOKEN = "";
const UID = 1732189; 

const client = AgoraRTC.createClient({ mode: "live", codec: "h264" });

let screenSharePlayer;

document.addEventListener("DOMContentLoaded", () => {
    screenSharePlayer = videojs("screenshare-video");

    client.on("user-published", async (user, mediaType) => {
        await client.subscribe(user, mediaType);

        if (mediaType === 'video') {
            const remoteVideoTrack = user.videoTrack;
            const stats = remoteVideoTrack.getStats();
            if (stats.receiveResolutionWidth === 160 && stats.receiveResolutionHeight === 120) {
                // Facecam
                const facecamPlayer = document.getElementById('facecam-video');
                remoteVideoTrack.play(facecamPlayer);
            } else {
                // Screen share
                const mediaStream = new MediaStream([remoteVideoTrack.getMediaStreamTrack()]);
                screenSharePlayer.srcObject = mediaStream;
                screenSharePlayer.play();
            }
        }

        if (mediaType === 'audio') {
            const remoteAudioTrack = user.audioTrack;
            remoteAudioTrack.play();
        }
    });

    client.on("user-unpublished", user => {
        const playerContainer = document.getElementById(user.uid);
        if (playerContainer) {
            playerContainer.remove();
        }
    });

    client.join(APP_ID, CHANNEL, TOKEN, UID).then(uid => {
        console.log("Joined channel successfully");
    }).catch(error => {
        console.error("Failed to join channel", error);
    });
});
