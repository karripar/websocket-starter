# Socket.io Chat Server

The solution is based on the example provided by [Socket.io](https://socket.io/docs/v4/tutorial/introduction).

On top of the base features, the following was added:
- '<username> is typing...' indicator when someone else is typing.
- Setting a nickname visible to others (required to send a message).
- Three chat rooms with different topics, with their own message history stored with SQLite.

### Server running through Azure:
![Azure Site](img/azure-frontend.png)

### Typing indicator
![Typing in progress](img/typing.png)

### Alternate rooms
![Programming room](img/second-room.png)
