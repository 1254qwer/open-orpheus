#![cfg(target_os = "macos")] // MPNowPlayingInfoCenter is a macOS only feature
#![deny(clippy::all)]

use std::ptr::NonNull;
use std::sync::{Arc, Mutex};

use block2::RcBlock;
use napi::{
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
    Error, Result,
};
use napi_derive::napi;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AnyThread;
use objc2_app_kit::NSImage;
use objc2_core_foundation::CGSize;
use objc2_foundation::{NSMutableDictionary, NSNumber, NSString, NSURL};
use objc2_media_player::{
    MPChangePlaybackPositionCommandEvent, MPMediaItemArtwork, MPMediaItemPropertyAlbumTitle,
    MPMediaItemPropertyArtist, MPMediaItemPropertyArtwork, MPMediaItemPropertyPlaybackDuration,
    MPMediaItemPropertyTitle, MPNowPlayingInfoCenter, MPNowPlayingInfoPropertyElapsedPlaybackTime,
    MPNowPlayingInfoPropertyPlaybackRate, MPNowPlayingPlaybackState, MPRemoteCommandCenter,
    MPRemoteCommandEvent, MPRemoteCommandHandlerStatus,
};

#[napi]
#[derive(Clone)]
pub enum MediaSessionEvents {
    Play,
    Pause,
    Toggle,
    Next,
    Previous,
    SetPosition { position: f64 },
    SetRate { rate: f64 },
}

#[napi(object)]
pub struct NowPlayingMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration: Option<f64>,
    pub elapsed: Option<f64>,
    pub rate: Option<f64>,
    /// Album-art URL string (or empty for none).
    pub art_url: Option<String>,
}

#[napi]
pub struct MediaSession {
    center: Retained<MPNowPlayingInfoCenter>,
    // Kept alive for the lifetime of the session; the command center is a
    // process-wide singleton, but holding the reference is harmless.
    #[allow(dead_code)]
    commands: Retained<MPRemoteCommandCenter>,
    event_handler: Arc<Mutex<Option<ThreadsafeFunction<MediaSessionEvents, ()>>>>,
}

#[napi]
impl MediaSession {
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        let center = unsafe { MPNowPlayingInfoCenter::defaultCenter() };
        let commands = unsafe { MPRemoteCommandCenter::sharedCommandCenter() };

        let event_handler: Arc<Mutex<Option<ThreadsafeFunction<MediaSessionEvents, ()>>>> =
            Arc::new(Mutex::new(None));

        unsafe {
            attach_command(
                &commands.playCommand(),
                &event_handler,
                MediaSessionEvents::Play,
            );
            attach_command(
                &commands.pauseCommand(),
                &event_handler,
                MediaSessionEvents::Pause,
            );
            attach_command(
                &commands.togglePlayPauseCommand(),
                &event_handler,
                MediaSessionEvents::Toggle,
            );
            attach_command(
                &commands.nextTrackCommand(),
                &event_handler,
                MediaSessionEvents::Next,
            );
            attach_command(
                &commands.previousTrackCommand(),
                &event_handler,
                MediaSessionEvents::Previous,
            );
        }

        // Change playback position (absolute, seconds).
        let handler = event_handler.clone();
        unsafe {
            commands.changePlaybackPositionCommand().setEnabled(true);
            let block: RcBlock<
                dyn Fn(NonNull<MPRemoteCommandEvent>) -> MPRemoteCommandHandlerStatus,
            > = RcBlock::new(move |event: NonNull<MPRemoteCommandEvent>| {
                let event = &*(event.as_ptr() as *const MPChangePlaybackPositionCommandEvent);
                let position = event.positionTime();
                fire_event(&handler, MediaSessionEvents::SetPosition { position });
                MPRemoteCommandHandlerStatus::Success
            });
            commands
                .changePlaybackPositionCommand()
                .addTargetWithHandler(&block);
        }

        Ok(Self {
            center,
            commands,
            event_handler,
        })
    }

    #[napi]
    pub fn set_event_handler(&self, handler: Option<ThreadsafeFunction<MediaSessionEvents, ()>>) {
        *self.event_handler.lock().unwrap() = handler;
    }

    /// Replaces the whole Now Playing info dictionary. `None` clears it.
    #[napi]
    pub fn set_metadata(&self, metadata: Option<NowPlayingMetadata>) -> Result<()> {
        let Some(metadata) = metadata else {
            unsafe { self.center.setNowPlayingInfo(None) };
            return Ok(());
        };

        unsafe {
            let dict = NSMutableDictionary::<NSString, AnyObject>::new();
            if let Some(title) = &metadata.title {
                dict.insert(MPMediaItemPropertyTitle, &NSString::from_str(title));
            }
            if let Some(artist) = &metadata.artist {
                dict.insert(MPMediaItemPropertyArtist, &NSString::from_str(artist));
            }
            if let Some(album) = &metadata.album {
                dict.insert(MPMediaItemPropertyAlbumTitle, &NSString::from_str(album));
            }
            if let Some(duration) = metadata.duration {
                dict.insert(
                    MPMediaItemPropertyPlaybackDuration,
                    &NSNumber::new_f64(duration),
                );
            }
            if let Some(elapsed) = metadata.elapsed {
                dict.insert(
                    MPNowPlayingInfoPropertyElapsedPlaybackTime,
                    &NSNumber::new_f64(elapsed),
                );
            }
            if let Some(rate) = metadata.rate {
                dict.insert(
                    MPNowPlayingInfoPropertyPlaybackRate,
                    &NSNumber::new_f64(rate),
                );
            }
            if let Some(art_url) = &metadata.art_url {
                if !art_url.is_empty() {
                    if let Some(url) = NSURL::URLWithString(&NSString::from_str(art_url)) {
                        if let Some(image) = NSImage::initWithContentsOfURL(NSImage::alloc(), &url)
                        {
                            let block: RcBlock<dyn Fn(CGSize) -> NonNull<NSImage>> =
                                RcBlock::new(move |_: CGSize| NonNull::from(&*image));
                            let artwork = MPMediaItemArtwork::initWithBoundsSize_requestHandler(
                                MPMediaItemArtwork::alloc(),
                                CGSize::new(512.0, 512.0),
                                &block,
                            );
                            dict.insert(MPMediaItemPropertyArtwork, &artwork);
                        }
                    }
                }
            }
            self.center.setNowPlayingInfo(Some(&dict));
        }
        Ok(())
    }

    /// macOS-specific playback state (used on macOS for Now Playing visibility).
    #[napi]
    pub fn set_playback_state(&self, state: String) -> Result<()> {
        let state = match state.as_str() {
            "playing" => MPNowPlayingPlaybackState::Playing,
            "paused" => MPNowPlayingPlaybackState::Paused,
            "stopped" => MPNowPlayingPlaybackState::Stopped,
            _ => {
                return Err(Error::from_reason(format!(
                    "Unknown playback state: {state}"
                )))
            }
        };
        unsafe { self.center.setPlaybackState(state) };
        Ok(())
    }
}

unsafe fn attach_command(
    command: &objc2_media_player::MPRemoteCommand,
    event_handler: &Arc<Mutex<Option<ThreadsafeFunction<MediaSessionEvents, ()>>>>,
    event: MediaSessionEvents,
) {
    command.setEnabled(true);
    let handler = event_handler.clone();
    let block: RcBlock<dyn Fn(NonNull<MPRemoteCommandEvent>) -> MPRemoteCommandHandlerStatus> =
        RcBlock::new(move |_event| {
            fire_event(&handler, event.clone());
            MPRemoteCommandHandlerStatus::Success
        });
    command.addTargetWithHandler(&block);
}

fn fire_event(
    handler: &Mutex<Option<ThreadsafeFunction<MediaSessionEvents, ()>>>,
    event: MediaSessionEvents,
) {
    if let Some(handler) = handler.lock().unwrap().as_ref() {
        let _ = handler.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
    }
}
