const { ApiGatewayManagementApi, DynamoDB } = require('aws-sdk');

const api = new ApiGatewayManagementApi({ endpoint: process.env.API_GATEWAY_WS_ENDPOINT, region: process.env.REGION });
const dynamo = new DynamoDB.DocumentClient({ apiVersion: '2012-08-10', region: process.env.REGION });

const sendMessage = async (ConnectionId, Data) => await api.postToConnection({ ConnectionId, Data }).promise();

exports.handler = async event => {
    const user_id = event.requestContext.connectionId;
    const route = event.requestContext.routeKey;

    try {
        if (route === '$connect') { } // do nothing

        else if (route === "$disconnect") { // group gets deleted in 8 hrs
            const data = await dynamo.scan({
                TableName: process.env.TABLE_NAME,
                FilterExpression: `contains(#users, :id)`,
                ExpressionAttributeNames: {
                    "#users": "users"
                },
                ExpressionAttributeValues: {
                    ":id": user_id
                }
            }).promise();

            const users = data.Items[0].users;
            const names = data.Items[0].names;

            const index = users.indexOf(user_id);

            if (index > -1) {
                users.splice(index, 1);
                names.splice(index, 1);

                if (users.length === 0) {
                    await dynamo.delete({
                        TableName: process.env.TABLE_NAME,
                        Key: {
                            'room-id': data.Items[0]['room-id']
                        },
                    }).promise();
                } else {
                    await dynamo.update({
                        TableName: process.env.TABLE_NAME,
                        Key: {
                            'room-id': data.Items[0]['room-id']
                        },
                        UpdateExpression: "set #users=:x, #names=:n",
                        ExpressionAttributeNames: {
                            "#users": "users",
                            "#names": "names"
                        },
                        ExpressionAttributeValues: {
                            ":x": [...users],
                            ":n": [...names]
                        },
                        ReturnValues: "UPDATED_NEW"
                    }).promise();

                    await Promise.all(users.map(async id => await sendMessage(id, JSON.stringify({ action: "usersConnected", names }))));
                }
            }
        } else if (route === 'join') {
            const body = JSON.parse(event.body);
            if (body['room-id'] && body.name) {
                const a = await dynamo.get({
                    TableName: process.env.TABLE_NAME,
                    Key: { 'room-id': body['room-id'] }
                }).promise();

                try {
                    const names = [...a.Item.names, body.name];
                    const users = [...a.Item.users, user_id];

                    await dynamo.update({
                        TableName: process.env.TABLE_NAME,
                        Key: {
                            'room-id': body['room-id']
                        },
                        UpdateExpression: "set #users=:x, #names=:n",
                        ExpressionAttributeNames: {
                            "#users": "users",
                            "#names": "names"
                        },
                        ExpressionAttributeValues: {
                            ":x": users,
                            ":n": names
                        },
                        ReturnValues: "UPDATED_NEW"
                    }).promise();

                    await sendMessage(user_id, JSON.stringify({ status: 200, message: 'added to group', names }));
                    await Promise.all(users.map(async id => await sendMessage(id, JSON.stringify({ action: "usersConnected", names }))))
                } catch {
                    await sendMessage(user_id, JSON.stringify({ status: 400, message: 'group dosent exist.' }));
                }
            } else {
                await sendMessage(user_id, JSON.stringify({ status: 400, message: 'room-id or name is noot given' }));
            }
        } else if (route === 'create-group') {
            const body = JSON.parse(event.body);

            if (body['room-id'] && body.link && body.name) {
                await dynamo.put({
                    TableName: process.env.TABLE_NAME,
                    Item: {
                        'room-id': body['room-id'],
                        users: [user_id],
                        link: body.link,
                        names: [body.name],
                        ttl: (Math.floor(Date.now() / 1000) + (8 * 3600))
                    }
                }).promise();

                await sendMessage(user_id, JSON.stringify({ status: 200, message: 'group created' }));
            } else {
                await sendMessage(user_id, JSON.stringify({ status: 400, message: 'room-id, user_name or link is missing' }));
            }
        } else if (route === 'jump') {
            const body = JSON.parse(event.body);

            if (body['room-id'] && body['time-frame']) {
                const roomsForJump = await dynamo.get({
                    TableName: process.env.TABLE_NAME,
                    Key: {
                        'room-id': body['room-id']
                    }
                }).promise();

                await Promise.all(roomsForJump.Item.users.map(async user => await sendMessage(user, JSON.stringify({ action: 'jump', 'time-frame': body['time-frame'] }))));
            } else {
                await sendMessage(user_id, JSON.stringify({ status: 400, message: 'room-id or time-frame is missing' }));
            }
        } else if (route === 'isPlaying') {
            const body = JSON.parse(event.body);

            if (body['room-id'] && typeof body['isPlaying'] === "boolean") {
                const roomsForJump = await dynamo.get({
                    TableName: process.env.TABLE_NAME,
                    Key: {
                        'room-id': body['room-id']
                    }
                }).promise();

                await Promise.all(roomsForJump.Item.users.map(async user => await sendMessage(user, JSON.stringify({ action: 'isPlaying', 'isPlaying': body['isPlaying'] }))));
            } else {
                await sendMessage(user_id, JSON.stringify({ status: 400, message: 'room-id or isPlaying is missing' }));
            }
        } else if (route === "letMeLive") {
            await sendMessage(user_id, JSON.stringify({ action: 'letMeLive', live: true }));
        } else if (route === "sendMessage") {
            const body = JSON.parse(event.body);

            if (body['room-id'] && body['message'] && body.name) {
                const roomsForJump = await dynamo.get({
                    TableName: process.env.TABLE_NAME,
                    Key: {
                        'room-id': body['room-id']
                    }
                }).promise();

                await Promise.all(roomsForJump.Item.users.map(async user => await sendMessage(user, JSON.stringify({ action: 'messasge', message: body['message'], name: body.name }))));
            } else {
                await sendMessage(user_id, JSON.stringify({ status: 400, message: 'room-id, name or message is missing' }));
            }
        }
    } catch (error) {
        return { statusCode: 300 };
    }

    return { statusCode: 200 };
};