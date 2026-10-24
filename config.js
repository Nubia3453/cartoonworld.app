// =====================================================================
//  TOONHOUSE SETTINGS — this is the only file you need to edit.
//  After changing anything here, save the file and reload the page.
// =====================================================================

// 1) The app's name, shown at the top of the page.
const APP_NAME = 'Toonhouse';

// 2) Your cartoon playlist.
//    Paste the playlist's ID between the quotes. It's the part after "list="
//    in the playlist's web address, e.g.  youtube.com/playlist?list=PLxxxxxxxx
//    Videos you add to the playlist later show up in the app on their own.
//    (You can also leave this empty and give each show its own playlist, see 3.)
const MAIN_PLAYLIST_ID = 'PLG2YwqBalemA';

// 3) Your shows — one line per show. Each show becomes a coloured tile.
//
//      name        What's written on the tile. Every show needs a different name.
//      match       Words to look for in the titles of the videos in MAIN_PLAYLIST_ID
//                  (capital letters don't matter). A video goes to the first show
//                  whose words it contains. Videos that match no show are listed
//                  under "More cartoons".
//      playlistId  (optional) Give a show its own YouTube playlist. Every video in
//                  it belongs to this show, whatever the video is called.
//      color       (optional) Tile colour, for example '#FFD23F'.
//
//    To add a show: copy a line, change the name and the words.
//    Keep the comma at the end of each line.
const SHOWS = [
  { name: 'Shinchan',         match: ['shinchan', 'shin chan', 'shin-chan'] },
  { name: 'Doraemon',         match: ['doraemon'] },
  { name: 'Phineas and Ferb', match: ['phineas', 'ferb', 'Phineas and Ferb'] },
  { name: 'Kick Buttowski: Suburban Daredevil', match: ['Kick', 'Buttowski', 'Suburban', 'Daredevil','Kick Buttowski'] },
  { name: 'Phineas and Ferb', match: ['phineas', 'ferb'] },
  { name: 'Ninja Hattori', match: ['Ninja', ,'Hattori', 'Ninja Hattori'] },
  { name: 'Kid vs Kat', match: ['kid', ,'kat', 'kid vs kat'] },

  // Example of a show with its own playlist (remove the // at the start to use it):
  // { name: 'Oggy', playlistId: 'PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
];
