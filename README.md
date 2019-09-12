# edinfo-server

Elite Dangerous is often missing a way to find out things like which nearby stations offer a specific service. Websites like [inara.cz](https://inara.cz) help fill this void, but edinfo-server aims to do it better.

## Features

- Provides your current in-game location, updated in real time through WebSockets
- Provides information on nearby stations using EDSM
- Works with separate clients -- for example, you could write an iPhone app that connects to this server
- Provides your customized Elite HUD color scheme for use by clients

Also see the [web app][webapp].

## Starting the server

Simply run `node main.js`. The server, and the web app if it's installed, will be available on port 3000.

## Security

#### This server only provides insecure HTTP. ####

**It is not intended to be secure.**

You should **only** use it on your local network, where you're reasonably confident other people won't be trying to intercept your network traffic.

You can also block it with your firewall, if you only plan on using it from the same machine.

## Alternate file locations

By default, the journals are assumed to be where Elite puts them on Windows:

|            |                                                   |
|------------|---------------------------------------------------|
| Journals   | Saved Games/Frontier Developments/Elite Dangerous |
| HUD matrix | AppData/Local/Frontier Developments/Elite Dangerous/Options/Graphics/GraphicsConfigurationOverride.xml |

You can tell edinfo-server to look for them somewhere else by passing the joural folder and HUD matrix file as arguments to the program.

```
node main.js /path/to/journals /path/to/GraphicsConfigurationOverride.xml
```

## Using a local cache

You can download a local cache of EDSM's station data [from their website][edsm-station-dump] and place it here, or run `./cache stations`. It's about 40 MB.

**A local station cache is highly recommended**, as otherwise you'll hit EDSM's rate limit in only a few requests! This happens because the server makes a separate API call for every nearby system in order to get the stations in it. If you're not using a cache, you can see EDSM's rate limiting information in the top right of the web app.

When the rate limit display is recharging, _that is an estimate_. It is only 100% reliable at the moment you make a request.

`./cache` supports downloading the systems cache, but using it is currently not implemented, and the server will fall back to EDSM anyway.

It also assumes you have [cURL](https://curl.haxx.se/) installed. If you don't want to install it, you can change the script to use wget instead or [download the stations cache manually][edsm-station-dump].

[webapp]: https://github.com/SilverWolf32/edinfo-server-webapp
[edsm-station-dump]: https://www.edsm.net/dump/stations.json
