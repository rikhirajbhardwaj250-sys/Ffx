const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* =====================================================
   FIREBASE ADMIN
===================================================== */

let firebaseReady = false;

try {
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "")
    .replace(/\\n/g, "\n");

  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    privateKey
  ) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey
      }),
      databaseURL:
        `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
    });

    firebaseReady = true;
    console.log("Firebase Admin ready");
  }
} catch (err) {
  console.error("Firebase initialization error:", err.message);
}

/* =====================================================
   AUTH
===================================================== */

async function requireAuth(req, res, next) {
  try {
    if (!firebaseReady) {
      return res.status(500).json({
        success: false,
        message: "Firebase Admin is not configured."
      });
    }

    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication token is required."
      });
    }

    const token = authHeader.substring(7);

    req.firebaseUser = await admin.auth().verifyIdToken(token);

    next();

  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token."
    });
  }
}

/* =====================================================
   ADMIN AUTH
===================================================== */

async function requireAdmin(req, res, next) {
  return requireAuth(req, res, async () => {
    try {
      const uid = req.firebaseUser.uid;
      const db = admin.database();

      const adminSnap = await db.ref(`admins/${uid}`).once("value");
      if (adminSnap.val() === true) {
        req.isAdmin = true;
        req.authRole = "Admin";
        req.staff = null;
        return next();
      }

      const staffSnap = await db.ref(`staff/${uid}`).once("value");
      const staff = staffSnap.val();
      if (staff && staff.status === "Active") {
        const role = String(staff.role || "Staff");
        const allowed = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.Staff;
        const permissions = {};
        allowed.forEach(p => permissions[p] = true);
        req.isAdmin = false;
        req.authRole = "Staff";
        req.staff = {...staff, permissions};
        return next();
      }

      const allowedEmails = (process.env.ADMIN_EMAILS || "")
        .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
      const email = String(req.firebaseUser.email || "").toLowerCase();
      if (allowedEmails.includes(email)) {
        req.isAdmin = true;
        req.authRole = "Admin";
        req.staff = null;
        return next();
      }

      return res.status(403).json({success:false,message:"Admin access denied."});
    } catch (err) {
      console.error("Admin auth:", err);
      return res.status(500).json({success:false,message:"Could not verify admin access."});
    }
  });
}

// Staff role permissions are enforced on the backend as well as hidden in the UI.
const ROLE_PERMISSIONS = {
  "Support": ["Support", "Notifications"],
  "Match Manager": ["Matches", "Match Results"],
  "Finance": ["Withdrawals", "Deposits", "Coupons", "Users"],
  "Content Manager": ["Content"],
  "Staff": ["Matches", "Match Results", "Users", "Withdrawals", "Deposits", "Notifications", "Coupons", "Content", "Support"]
};
function permissionForAdminPath(path="") {
  if (path.includes("/admin/staff")) return "Staff Management";
  if (path.includes("/admin/settle-match")) return "Match Results";
  if (path.includes("/admin/cancel-match")) return "Matches";
  if (path.includes("/admin/notifications")) return "Notifications";
  if (path.includes("/admin/coupons")) return "Coupons";
  if (path.includes("/admin/users")) return "Users";
  if (path.includes("/admin/withdrawals")) return "Withdrawals";
  if (path.includes("/admin/deposits")) return "Deposits";
  if (path.includes("/admin/banners") || path.includes("/admin/tutorials")) return "Content";
  if (path.includes("/admin/support")) return "Support";
  if (path.includes("/admin/settings")) return "Payment Settings";
  return null;
}
async function requirePermission(req, res, next) {
  const permission = permissionForAdminPath(req.path || req.originalUrl || "");
  if (!permission || req.isAdmin) return next();
  const permissions = req.staff?.permissions || {};
  if (permissions[permission]) return next();
  return res.status(403).json({success:false,message:`Your staff role does not have permission for ${permission}.`});
}

app.get('/api/admin/me', requireAdmin, requirePermission, async (req,res)=>{
  res.json({success:true,role:req.authRole||'Admin',email:req.firebaseUser.email||'',permissions:req.staff?.permissions||{}});
});

/* =====================================================
   USER - REDEEM COUPON
===================================================== */

app.post(
  "/api/coupons/redeem",
  requireAuth,
  async (req, res) => {

    try {

      const uid =
        req.firebaseUser.uid;

      const code =
        String(
          req.body?.code || ""
        )
        .trim()
        .toUpperCase();

      if (!code) {

        return res.status(400).json({
          success: false,
          message:
            "Enter a coupon code."
        });

      }

      const coupon =
        await Coupon.findOne({
          code
        });

      if (!coupon) {

        return res.status(404).json({
          success: false,
          message:
            "Invalid coupon code."
        });

      }

      if (
        coupon.expiryDate &&
        new Date(coupon.expiryDate) <
        new Date()
      ) {

        return res.status(400).json({
          success: false,
          message:
            "This coupon has expired."
        });

      }

      if (
        coupon.usedCount >=
        coupon.maxUses
      ) {

        return res.status(400).json({
          success: false,
          message:
            "This coupon has reached its usage limit."
        });

      }

      const redemptionRef =
        database().ref(
          `users/${uid}/redeemedCoupons/${code}`
        );

      const already =
        await redemptionRef.once(
          "value"
        );

      if (already.exists()) {

        return res.status(400).json({
          success: false,
          message:
            "You have already redeemed this code."
        });

      }

      const claim =
        await redemptionRef.transaction(
          value =>
            value
              ? undefined
              : {
                  amount:
                    coupon.amount,

                  timestamp:
                    admin.database
                      .ServerValue
                      .TIMESTAMP
                }
        );

      if (!claim.committed) {

        return res.status(400).json({
          success: false,
          message:
            "You have already redeemed this code."
        });

      }

      const walletRef = database().ref(`users/${uid}/wallet/balance`);
      const reward = Number(coupon.amount || 0);
      let before = 0;
      let after = 0;

      try {
        const walletTx = await walletRef.transaction(balance => {
          before = Number(balance || 0);
          after = before + reward;
          return after;
        });
        if (!walletTx.committed) throw new Error('Could not update wallet balance.');
        after = Number(walletTx.snapshot.val() || 0);

        await database()
          .ref(
            `users/${uid}/walletTransactions`
          )
          .push()
          .set({

            type:
              "Redeem Code",

            amount:
              reward,

            balanceBefore:
              before,

            balanceAfter:
              after,

            referenceId:
              code,

            timestamp:
              admin.database
                .ServerValue
                .TIMESTAMP

          });

        await Coupon.updateOne(
          {
            code,
            usedCount: {
              $lt:
                coupon.maxUses
            }
          },
          {
            $inc: {
              usedCount: 1
            }
          }
        );

        return res.json({

          success: true,

          amount:
            reward,

          message:
            "Coupon redeemed successfully."

        });

      } catch (err) {

        await redemptionRef.remove();

        throw err;

      }

    } catch (err) {

      console.error(
        "Redeem:",
        err
      );

      return res.status(500).json({

        success: false,
message:
          "Could not redeem coupon right now."

      });

    }

  }
);



/* =====================================================
   USER - TOURNAMENT LIST
===================================================== */
app.get('/api/tournaments', async (req,res)=>{
  try{
    const raw=(await database().ref('tournaments').once('value')).val()||{};
    const tournaments=Object.entries(raw).map(([id,t])=>{
      t=t||{};
      let subpoints=t.subpoints;
      if(typeof subpoints==='string') subpoints=subpoints.split(',').map(x=>x.trim()).filter(Boolean);
      if(!Array.isArray(subpoints)) subpoints=[];
      return {id,...t,occupiedSlots:Number(t.occupiedSlots||0),maxPlayers:Number(t.maxPlayers||0),subpoints};
    });
    res.json({success:true,tournaments});
  }catch(err){ console.error('Tournaments list:',err); res.status(500).json({success:false,message:'Could not load tournaments.'}); }
});

/* =====================================================
   USER - SUPPORT TICKETS
===================================================== */
app.post('/api/support/tickets', requireAuth, async (req,res)=>{
  try{
    const uid=req.firebaseUser.uid;
    const subject=String(req.body?.subject||'').trim();
    const message=String(req.body?.message||'').trim();
    if(!subject||!message) return res.status(400).json({success:false,message:'Subject and message are required.'});
    const us=(await database().ref(`users/${uid}`).once('value')).val()||{};
    const p=us.profile||{};
    const ref=database().ref('supportTickets').push();
    await ref.set({uid,userName:p.fullName||p.ign||'User',phone:p.phone||'',subject,message,status:'Open',reply:'',replies:{},timestamp:admin.database.ServerValue.TIMESTAMP});
    res.json({success:true,message:'Support ticket submitted successfully.',ticketId:ref.key});
  }catch(err){console.error('Support create:',err);res.status(500).json({success:false,message:'Could not submit support ticket.'});}
});
app.get('/api/support/tickets', requireAuth, async (req,res)=>{
  try{
    const raw=(await database().ref('supportTickets').orderByChild('uid').equalTo(req.firebaseUser.uid).once('value')).val()||{};
    const tickets=Object.entries(raw).map(([id,v])=>({id,...(v||{})})).sort((x,y)=>Number(y.timestamp||0)-Number(x.timestamp||0));
    res.json({success:true,tickets});
  }catch(err){res.status(500).json({success:false,message:'Could not load support tickets.'});}
});
app.get('/api/admin/support/tickets', requireAdmin, requirePermission, async (req,res)=>{
  try{
    const raw=(await database().ref('supportTickets').once('value')).val()||{};
    const tickets=Object.entries(raw).map(([id,v])=>({id,...(v||{})})).sort((x,y)=>Number(y.timestamp||0)-Number(x.timestamp||0));
    res.json({success:true,tickets});
  }catch(err){res.status(500).json({success:false,message:'Could not load support tickets.'});}
});
app.post('/api/admin/support/tickets/:id/reply', requireAdmin, requirePermission, async (req,res)=>{
  try{
    const message=String(req.body?.message||'').trim();
    if(!message) return res.status(400).json({success:false,message:'Reply cannot be empty.'});
    const ref=database().ref(`supportTickets/${req.params.id}`);
    const snap=await ref.once('value'); if(!snap.exists()) return res.status(404).json({success:false,message:'Ticket not found.'});
    const r=ref.child('replies').push();
    await r.set({message,by:req.firebaseUser.uid,timestamp:admin.database.ServerValue.TIMESTAMP});
    await ref.update({reply:message,status:'Replied',repliedAt:admin.database.ServerValue.TIMESTAMP});
    res.json({success:true,message:'Reply sent.'});
  }catch(err){res.status(500).json({success:false,message:'Could not reply to ticket.'});}
});
app.post('/api/admin/support/tickets/:id/resolve', requireAdmin, requirePermission, async (req,res)=>{
  try{await database().ref(`supportTickets/${req.params.id}`).update({status:'Resolved',resolvedAt:admin.database.ServerValue.TIMESTAMP});res.json({success:true,message:'Ticket resolved.'});}
  catch(err){res.status(500).json({success:false,message:'Could not resolve ticket.'});}
});

/* =====================================================
   ADMIN - STAFF
===================================================== */
app.post('/api/admin/staff', requireAdmin, requirePermission, async (req,res)=>{
  try{
    const name=String(req.body?.name||'').trim(), email=String(req.body?.email||'').trim().toLowerCase(), password=String(req.body?.password||''), role=String(req.body?.role||'Staff');
    if(!name||!email||password.length<6) return res.status(400).json({success:false,message:'Name, valid email and a password of at least 6 characters are required.'});
    if(!ROLE_PERMISSIONS[role]) return res.status(400).json({success:false,message:'Invalid staff role.'});
    const cred=await admin.auth().createUser({email,password,displayName:name,emailVerified:false});
    const permissions={}; (ROLE_PERMISSIONS[role]||[]).forEach(p=>permissions[p]=true);
    await database().ref(`staff/${cred.uid}`).set({name,email,role,status:'Active',permissions,createdAt:admin.database.ServerValue.TIMESTAMP});
    res.json({success:true,message:'Staff account created successfully.',uid:cred.uid});
  }catch(err){console.error('Staff create:',err);let msg=err.code==='auth/email-already-exists'?'This email is already registered.':err.message||'Could not create staff account.';res.status(400).json({success:false,message:msg});}
});

app.post('/api/admin/staff/:uid/role', requireAdmin, requirePermission, async (req,res)=>{
  try{
    const uid=String(req.params.uid||''); const role=String(req.body?.role||'');
    if(!ROLE_PERMISSIONS[role]) return res.status(400).json({success:false,message:'Invalid staff role.'});
    const permissions={}; (ROLE_PERMISSIONS[role]||[]).forEach(p=>permissions[p]=true);
    await database().ref(`staff/${uid}`).update({role,permissions,updatedAt:admin.database.ServerValue.TIMESTAMP});
    res.json({success:true,message:`Staff role changed to ${role}.`});
  }catch(err){res.status(500).json({success:false,message:'Could not update staff role.'});}
});

/* =====================================================
   PAYMENT SETTINGS
===================================================== */
app.get('/api/settings/payment', async (req,res)=>{
  try{const s=(await database().ref('settings/payment').once('value')).val()||{minDeposit:10,maxDeposit:10000,status:'ON'};res.json({success:true,settings:s});}
  catch(err){res.status(500).json({success:false,message:'Could not load payment settings.'});}
});
app.post('/api/admin/settings/payment', requireAdmin, requirePermission, async (req,res)=>{
  try{
    const settings={minDeposit:Number(req.body?.minDeposit||10),maxDeposit:Number(req.body?.maxDeposit||10000),status:req.body?.status==='OFF'?'OFF':'ON'};
    await database().ref('settings/payment').set(settings);
    res.json({success:true,message:'Settings saved successfully.',settings});
  }catch(err){res.status(500).json({success:false,message:'Could not save settings.'});}
});

/* =====================================================
   REFERRAL
===================================================== */
app.get('/api/me/referral', requireAuth, async (req,res)=>{
  try{
    const uid=req.firebaseUser.uid;
    const ref=database().ref(`users/${uid}/profile/referralCode`);
    let code=(await ref.once('value')).val();
    if(!code){code='FFX'+uid.slice(0,8).toUpperCase();await ref.set(code);}
    res.json({success:true,referralCode:code});
  }catch(err){res.status(500).json({success:false,message:'Could not load referral code.'});}
});

/* =====================================================
   FCM TOKEN REGISTRATION
===================================================== */
app.post('/api/fcm/token', requireAuth, async (req,res)=>{
  try{
    const token=String(req.body?.token||'').trim(); if(!token) return res.status(400).json({success:false,message:'FCM token is required.'});
    await database().ref(`fcmTokens/${req.firebaseUser.uid}`).push().set({token,updatedAt:admin.database.ServerValue.TIMESTAMP});
    res.json({success:true,message:'Push token registered.'});
  }catch(err){res.status(500).json({success:false,message:'Could not register push token.'});}
});


/* =====================================================
   USER - JOIN TOURNAMENT
===================================================== */

app.post(
  "/api/tournaments/join",
  requireAuth,
  async (req, res) => {

    try {

      const uid =
        req.firebaseUser.uid;

      const tournamentId =
        String(
          req.body?.tournamentId || ""
        );

      if (!tournamentId) {

        return res.status(400).json({
          success: false,
          message:
            "Tournament ID is required."
        });

      }

      const tournamentRef =
        database()
          .ref(
            `tournaments/${tournamentId}`
          );

      const snap =
        await tournamentRef
          .once("value");

      const tournament =
        snap.val();

      if (!tournament) {

        return res.status(404).json({
          success: false,
          message:
            "Tournament not found."
        });

      }

      if (
        tournament.status &&
        ![
          "Registration Open",
          "Open"
        ].includes(
          tournament.status
        )
      ) {

        return res.status(400).json({
          success: false,
          message:
            "Registration is closed."
        });

      }

      const existing =
        await tournamentRef
          .child(
            `participants/${uid}`
          )
          .once("value");

      if (existing.exists()) {

        return res.status(400).json({
          success: false,
          message:
            "You already joined this tournament."
        });

      }

      const fee = Number(tournament.entryFee || 0);
      const requestedSlot = Number(req.body?.slot || 0);
      const maxPlayers = Number(tournament.maxPlayers || 0);
      const newSlot = requestedSlot > 0 ? requestedSlot : Number(tournament.occupiedSlots || 0) + 1;
      if (maxPlayers > 0 && newSlot > maxPlayers) {
        return res.status(400).json({success:false,message:'No slots available.'});
      }

      // Never deduct money before the requested slot is reserved.
      const slotRef = tournamentRef.child(`slots/${newSlot}`);
      const slotReservation = await slotRef.transaction(current => current ? undefined : {
        uid, reservedAt: admin.database.ServerValue.TIMESTAMP
      });
      if (!slotReservation.committed) {
        return res.status(400).json({success:false,message:'That slot is already occupied.'});
      }

      const walletRef = database().ref(`users/${uid}/wallet/balance`);
      const walletTx = await walletRef.transaction(balance => {
        const current = Number(balance || 0);
        if (current < fee) return undefined;
        return current - fee;
      });
      if (!walletTx.committed) {
        await slotRef.remove();
        return res.status(400).json({success:false,message:'Insufficient wallet balance.'});
      }

      const userSnap = await database().ref(`users/${uid}`).once('value');
      const user = userSnap.val() || {};
      const profile = user.profile || {};
      const participant = {
        uid,
        ign: profile.ign || '',
        ffUid: profile.freefireUid || '',
        fullName: profile.fullName || '',
        joinedAt: admin.database.ServerValue.TIMESTAMP,
        slot: newSlot,
        entryFee: fee,
        position: String(req.body?.position || '')
      };
      if (req.body?.playerDetails) {
        participant.ign = String(req.body.playerDetails.ign || participant.ign);
        participant.ffUid = String(req.body.playerDetails.ffUid || participant.ffUid);
        participant.fullName = String(req.body.playerDetails.fullName || participant.fullName);
      }

      const participantRef = tournamentRef.child(`participants/${uid}`);
      const participantTx = await participantRef.transaction(current => current ? undefined : participant);
      if (!participantTx.committed) {
        await slotRef.remove();
        await walletRef.transaction(balance => Number(balance || 0) + fee);
        return res.status(400).json({success:false,message:'You already joined this tournament.'});
      }
      const countSnap=await tournamentRef.child('participants').once('value');
      const count=countSnap.numChildren();
      await tournamentRef.update({occupiedSlots:count,status:(maxPlayers>0 && count>=maxPlayers)?'Full':'Registration Open'});

      await database()
        .ref(
          `users/${uid}/joinedMatches/${tournamentId}`
        )
        .set({

          name:
            tournament.name ||
            "Tournament",

          date:
            tournament.date ||
            "",

          slot:
            newSlot,

          tournamentId

        });

      if (fee > 0) {

        await database()
          .ref(
            `users/${uid}/walletTransactions`
          )
          .push()
          .set({

            type:
              "Tournament Entry",

            amount:
              fee,

            balanceAfter:
              transaction.snapshot.val(),

            referenceId:
              tournamentId,

            timestamp:
              admin.database
                .ServerValue
                .TIMESTAMP

          });

      }

      return res.json({

        success: true,

        message:
          "Tournament joined successfully."

      });

    } catch (err) {

      console.error(
        "Join:",
        err
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not join tournament."

      });

    }

  }
);


/* =====================================================
   USER - AUTHORITATIVE WALLET
===================================================== */
app.get('/api/me/wallet', requireAuth, async (req,res)=>{
  try{
    const w=(await database().ref(`users/${req.firebaseUser.uid}/wallet`).once('value')).val()||{};
    res.json({success:true,balance:Number(w.balance||0),wallet:w});
  }catch(err){res.status(500).json({success:false,message:'Could not load wallet balance.'});}
});

/* =====================================================
   USER - WITHDRAWAL
===================================================== */

app.post(
  "/api/withdrawals",
  requireAuth,
  async (req, res) => {

    try {

      const uid =
        req.firebaseUser.uid;

      const amount =
        Number(
          req.body?.amount
        );

      const details =
        String(
          req.body?.details || ""
        ).trim();

      if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        !details
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Enter a valid amount and UPI ID."

        });

      }

      const walletRef =
        database().ref(
          `users/${uid}/wallet/balance`
        );

      const transaction =
        await walletRef.transaction(
          balance => {

            const current =
              Number(balance || 0);

            if (current < amount) {
              return undefined;
            }

            return current - amount;

          }
        );

      if (!transaction.committed) {

        return res.status(400).json({

          success: false,

          message:
            "Insufficient wallet balance."

        });

      }

      const userSnap =
        await database()
          .ref(`users/${uid}`)
          .once("value");

      const user =
        userSnap.val() || {};

      const profile =
        user.profile || {};

      const withdrawalRef =
        database()
          .ref("withdrawals")
          .push();

      await withdrawalRef.set({

        uid,

        userName:
          profile.fullName ||
          "User",

        phone:
          profile.phone ||
          "",

        amount,

        details,

        status:
          "Pending",

        createdAt:
          admin.database
            .ServerValue
            .TIMESTAMP

      });

      await database()
        .ref(
          `users/${uid}/walletTransactions`
        )
        .push()
        .set({

          type:
            "Withdrawal Hold",

          amount,

          balanceAfter:
            transaction.snapshot.val(),

          referenceId:
            withdrawalRef.key,

          timestamp:
            admin.database
              .ServerValue
              .TIMESTAMP

        });

      return res.json({

        success: true,

        message:
          "Withdrawal request submitted."

      });

    } catch (err) {

      console.error(
        "Withdrawal:",
        err
      );

      return res.status(500).json({

        success: false,

        message:
          "Withdrawal service error."

      });

    }

  }
);

/* =====================================================
   ADMIN - NOTIFICATIONS
===================================================== */

app.post(
  "/api/admin/notifications",
  requireAdmin,
  requirePermission,
  async (req, res) => {

    try {

      const title =
        String(
          req.body?.title || ""
        ).trim();

      const message =
        String(
          req.body?.message || ""
        ).trim();

      const targetUser =
        String(
          req.body?.targetUser ||
          "ALL"
        ).trim();

      if (!title || !message) {

        return res.status(400).json({

          success: false,

          message:
            "Title and message are required."

        });

      }

      const notification =
        await Notification.create({

          title,

          message,

          targetUser

        });

      const users =
        (
          await database()
            .ref("users")
            .once("value")
        ).val() || {};

      const updates = {};

      if (targetUser === "ALL") {

        Object.keys(users)
          .forEach(uid => {

            updates[
              `notifications/${uid}/${notification._id}`
            ] = {

              title,

              message,

              read: false,

              sentAt:
                admin.database
                  .ServerValue
                  .TIMESTAMP

            };

          });

      } else {

        updates[
          `notifications/${targetUser}/${notification._id}`
        ] = {

          title,

          message,

          read: false,

          sentAt:
            admin.database
              .ServerValue
              .TIMESTAMP

        };

      }

      if (Object.keys(updates).length) await database().ref().update(updates);

      // Also send real Web Push notifications to registered FCM tokens.
      try {
        const tokenRoot=(await database().ref('fcmTokens').once('value')).val()||{};
        const targetUids=targetUser==='ALL'?Object.keys(tokenRoot):[targetUser];
        const tokens=[]; targetUids.forEach(uid=>{const node=tokenRoot[uid]||{};Object.values(node).forEach(x=>{if(x&&x.token)tokens.push(x.token);});});
        for(let n=0;n<tokens.length;n+=500){const chunk=tokens.slice(n,n+500); if(chunk.length) await admin.messaging().sendEachForMulticast({tokens:chunk,data:{title,body:message,message,type:'admin',link:'https://ffx-tournament.netlify.app/'}});}
      } catch(pushErr) { console.warn('FCM send skipped:',pushErr.message); }

      return res.json({

        success: true,

        message:
          "Notification sent."

      });

    } catch (err) {

      console.error(
        "Notification:",
        err
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not send notification."

      });

    }

  }
);


/* =====================================================
   ADMIN - COUPONS
===================================================== */

app.post(
  "/api/admin/coupons",
  requireAdmin,
  requirePermission,
  async (req, res) => {

    try {

      const code =
        (
          String(
            req.body?.code || ""
          )
          .trim()
          .toUpperCase()
        ) ||
        (
          "FFX" +
          Math.random()
            .toString(36)
            .slice(2, 8)
            .toUpperCase()
        );

      const amount =
        Number(
          req.body?.amount
        );

      const maxUses =
        Math.max(
          1,
          Number(
            req.body?.maxUses || 1
          )
        );

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid reward amount."

        });

      }

      const coupon =
        await Coupon.create({

          code,

          amount,

          maxUses,

          expiryDate:
            req.body?.expiryDate
              ? new Date(
                  req.body.expiryDate
                )
              : undefined

        });

      return res.json({

        success: true,

        coupon

      });

    } catch (err) {

      return res.status(400).json({

        success: false,

        message:
          err.code === 11000
            ? "Coupon code already exists."
            : err.message

      });

    }

  }
);

app.get(
  "/api/admin/coupons",
  requireAdmin,
  requirePermission,
  async (req, res) => {

    const coupons =
      await Coupon.find()
        .sort({
          createdAt: -1
        })
        .lean();

    res.json({
      success: true,
      coupons
    });

  }
);

app.delete(
  "/api/admin/coupons/:id",
  requireAdmin,
  requirePermission,
  async (req, res) => {

    await Coupon.findByIdAndDelete(
      req.params.id
    );

    res.json({

      success: true,

      message:
        "Coupon deleted."

    });

  }
);


/* =====================================================
   ADMIN - USERS
===================================================== */

app.post(
  "/api/admin/users/:uid/block",
  requireAdmin,
  requirePermission,
  async (req, res) => {

    const blocked =
      !!req.body?.blocked;

    await database()
      .ref(
        `users/${req.params.uid}/profile/isBlocked`
      )
      .set(blocked);

    res.json({

      success: true,

      message:
        blocked
          ? "User blocked."
          : "User unblocked."

    });

  }
);


app.post(
  "/api/admin/users/:uid/wallet",
  requireAdmin,
  requirePermission,
  async (req, res) => {

    try {

      const uid =
        req.params.uid;

      const amount =
        Number(
          req.body?.amount
        );

      const reason =
        String(
          req.body?.reason ||
          "Admin adjustment"
        );

      if (
        !Number.isFinite(amount) ||
        amount === 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Amount cannot be zero."

        });

      }

      const walletRef =
        database()
          .ref(
            `users/${uid}/wallet/balance`
          );

      const transaction =
        await walletRef.transaction(
          balance =>
            Number(balance || 0) +
            amount
        );

      if (
        !transaction.committed ||
        Number(
          transaction.snapshot.val()
        ) < 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Wallet adjustment failed."

        });

      }

      await database()
        .ref(
          `users/${uid}/walletTransactions`
        )
        .push()
        .set({

          type:
            "Admin Adjustment",

          amount:
            Math.abs(amount),

          direction:
            amount > 0
              ? "Credit"
              : "Debit",

          reason,

          balanceAfter:
            transaction.snapshot.val(),

          timestamp:
            admin.database
              .ServerValue
              .TIMESTAMP

        });

      res.json({

        success: true,

        balance:
          transaction.snapshot.val()

      });

    } catch (err) {

      res.status(500).json({

        success: false,

        message:
          err.message

      });

    }

  }
);


/*
=====================================================
   ADMIN - WITHDRAWALS
===================================================== */

app.get(
  "/api/admin/withdrawals",
  requireAdmin,
  requirePermission,
  async (req, res) => {

    const withdrawals =
      (
        await database()
          .ref("withdrawals")
          .once("value")
      ).val() || {};

    res.json({

      success: true,

      withdrawals

    });

  }
);


app.post(
  "/api/admin/withdrawals/:id/process",
  requireAdmin,
  requirePermission,
  async (req, res) => {

    try {

      const status =
        req.body?.status;

      const id =
        req.params.id;

      if (
        ![
          "Approved",
          "Rejected"
        ].includes(status)
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid withdrawal status."

        });

      }

      const withdrawalRef =
        database()
          .ref(
            `withdrawals/${id}`
          );

      const snap =
        await withdrawalRef
          .once("value");

      const withdrawal =
        snap.val();

      if (!withdrawal) {

        return res.status(404).json({

          success: false,

          message:
            "Withdrawal not found."

        });

      }

      if (
        withdrawal.status !==
        "Pending"
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Withdrawal already processed."

        });

      }

      /* Refund only on rejection */

      if (
        status === "Rejected"
      ) {

        const walletRef =
          database()
            .ref(
              `users/${withdrawal.uid}/wallet/balance`
            );

        const transaction =
          await walletRef.transaction(
            balance =>
              Number(balance || 0) +
              Number(
                withdrawal.amount || 0
              )
          );

        await database()
          .ref(
            `users/${withdrawal.uid}/walletTransactions`
          )
          .push()
          .set({

            type:
              "Withdrawal Refund",

            amount:
              Number(
                withdrawal.amount || 0
              ),

            balanceAfter:
              transaction.snapshot.val(),

            referenceId:
              id,

            timestamp:
              admin.database
                .ServerValue
                .TIMESTAMP

          });

      }

      await withdrawalRef.update({

        status,

        processedAt:
          admin.database
            .ServerValue
            .TIMESTAMP,

        processedBy:
          req.firebaseUser.uid

      });

      res.json({

        success: true,

        message:
          `Withdrawal ${status}.`

      });

    } catch (err) {

      res.status(500).json({

        success: false,

        message:
          err.message

      });

    }

  }
);


/* =====================================================
   ADMIN - DEPOSITS
===================================================== */

app.get(
  "/api/admin/deposits",
  requireAdmin,
  requirePermission,
  async (req, res) => {

    const deposits =
      await PaymentOrder.find()
        .sort({
          createdAt: -1
        })
        .limit(200)
        .lean();

    res.json({

      success: true,

      deposits

    });

  }
);


/* =====================================================
   ADMIN - CANCEL MATCH + REFUND ENTRY FEES
===================================================== */
app.post('/api/admin/cancel-match', requireAdmin, requirePermission, async (req,res)=>{
  try{
    const tournamentId=String(req.body?.tournamentId||'').trim();
    let reason=String(req.body?.reason||'Low number of players').trim();
    const customReason=String(req.body?.customReason||'').trim();
    if(!tournamentId) return res.status(400).json({success:false,message:'Tournament ID is required.'});
    if(reason==='Other') reason=customReason||'Match cancelled by admin.';
    const ref=database().ref(`tournaments/${tournamentId}`);
    const snap=await ref.once('value');
    const tournament=snap.val();
    if(!tournament) return res.status(404).json({success:false,message:'Tournament not found.'});
    if(tournament.status==='Cancelled' || tournament.refundStatus==='Completed') return res.status(400).json({success:false,message:'This match is already cancelled and refunded.'});
    if(tournament.settlementStatus==='Completed') return res.status(400).json({success:false,message:'Settled matches cannot be cancelled.'});

    const participants=tournament.participants||{};
    const notificationTitle='Match Cancelled & Coins Refunded';
    const notificationMessage=`${tournament.name||'Your tournament'} was cancelled. Reason: ${reason}. Your entry fee has been refunded to your FFX wallet.`;
    const updates={};
    const refunded=[];
    const now=admin.database.ServerValue.TIMESTAMP;

    for(const uid of Object.keys(participants)){
      const p=participants[uid]||{};
      const fee=Math.max(0,Number(p.entryFee ?? tournament.entryFee ?? 0));
      const walletRef=database().ref(`users/${uid}/wallet/balance`);
      const tx=await walletRef.transaction(balance=>Number(balance||0)+fee);
      const balanceAfter=Number(tx.snapshot?.val()||0);
      if(fee>0){
        await database().ref(`users/${uid}/walletTransactions`).push().set({type:'Tournament Refund',amount:fee,balanceAfter,referenceId:tournamentId,reason,timestamp:now});
      }
      updates[`notifications/${uid}/${tournamentId}_cancel_${Date.now()}_${Math.random().toString(36).slice(2,7)}`]={title:notificationTitle,message:notificationMessage,read:false,sentAt:now,type:'match_cancelled',tournamentId};
      await database().ref(`users/${uid}/joinedMatches/${tournamentId}`).remove();
      if (participant.slot) await ref.child(`slots/${participant.slot}`).remove();
      refunded.push({uid,fee});
    }

    await ref.update({status:'Cancelled',cancelReason:reason,cancelledAt:now,refundStatus:'Completed',refundedPlayers:refunded.length,occupiedSlots:0,participants:{}});
    if(Object.keys(updates).length) await database().ref().update(updates);

    // Send mobile FCM notification using data-only payload so the service worker displays it.
    try{
      const tokenRoot=(await database().ref('fcmTokens').once('value')).val()||{};
      const tokens=[]; refunded.forEach(x=>{const node=tokenRoot[x.uid]||{};Object.values(node).forEach(v=>{if(v?.token)tokens.push(v.token);});});
      for(let i=0;i<tokens.length;i+=500){
        const chunk=tokens.slice(i,i+500);
        if(chunk.length) await admin.messaging().sendEachForMulticast({tokens:chunk,data:{title:notificationTitle,body:notificationMessage,type:'match_cancelled',tournamentId:String(tournamentId),link:'https://ffx-tournament.netlify.app/'}});
      }
    }catch(pushErr){console.warn('Cancel-match FCM skipped:',pushErr.message);}

    return res.json({success:true,message:`Match cancelled. ${refunded.length} player(s) refunded.`,refundedPlayers:refunded.length});
  }catch(err){
    console.error('Cancel match:',err);
    return res.status(500).json({success:false,message:'Could not cancel match and process refunds.'});
  }
});

/* =====================================================
   ADMIN - MATCH SETTLEMENT
===================================================== */

app.post(
  "/api/admin/settle-match",
  requireAdmin,
  requirePermission,
  async (req, res) => {

    try {

      const {
        tournamentId,
        players
      } = req.body || {};

      const tournamentRef =
        database()
          .ref(
            `tournaments/${tournamentId}`
          );

      const snap =
        await tournamentRef
          .once("value");

      const tournament =
        snap.val();

      if (!tournament) {

        return res.status(404).json({

          success: false,

          message:
            "Tournament not found."

        });

      }

      if (
        tournament.settlementStatus ===
        "Completed"
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Match is already settled."

        });

      }

      const resultList =
        Array.isArray(players)
          ? players
          : [];

      const results = {};

      for (
        const player of resultList
      ) {

        const uid =
          String(
            player.uid || ""
          );

        if (!uid) continue;

        let reward = 0;

        /* Per Kill */

        if (
          tournament.rewardMode ===
          "Per Kill"
        ) {

          reward =
            Math.max(
              0,
              Number(
                player.kills || 0
              )
            ) *
            Number(
              tournament.rewardPerKill ||
              0
            );

        }

        /* Prize Pool */

        else if (
          tournament.payoutMode ===
          "Position"
        ) {

          const prizes =
            tournament
              .prizesByPosition || {};

          reward =
            Number(
              prizes[
                String(
                  player.position
                )
              ] || 0
            );

        }

        /* Win / Lose / Booyah */

        else {

          const outcome =
            String(
              player.outcome || ""
            ).toLowerCase();

          if (
            outcome ===
            "booyah"
          ) {

            reward =
              Number(
                tournament.booyahPrize ||
                tournament.winPrize ||
                0
              );

          } else if (
            outcome === "win" ||
            outcome === "won"
          ) {

            reward =
              Number(
                tournament.winPrize ||
                0
              );

          } else if (
            outcome === "lose" ||
            outcome === "lost"
          ) {

            reward =
              Number(
                tournament.losePrize ||
                0
              );

          }

        }

        const walletRef =
          database()
            .ref(
              `users/${uid}/wallet/balance`
            );

        const transaction =
          await walletRef.transaction(
            balance =>
              Number(balance || 0) +
              reward
          );

        const balanceAfter =
          Number(
            transaction.snapshot.val()
          );

        if (reward > 0) {

          await database()
            .ref(
              `users/${uid}/walletTransactions`
            )
            .push()
            .set({

              type:
                tournament.rewardMode ===
                "Per Kill"
                  ? "Per Kill Reward"
                  : "Match Reward",

              amount:
                reward,

              balanceAfter,

              referenceId:
                tournamentId,

              timestamp:
                admin.database
                  .ServerValue
                  .TIMESTAMP

            });

        }

        results[uid] = {

          kills:
            Number(
              player.kills || 0
            ),

          position:
            Number(
              player.position || 0
            ),

          outcome:
            player.outcome || "",

          rewardAmount:
            reward,

          settlementStatus:
            "Completed"

        };

        await database()
          .ref(
            `users/${uid}/wallet/totalKills`
          )
          .transaction(
            value =>
              Number(value || 0) +
              Number(
                player.kills || 0
              )
          );

        await database()
          .ref(
            `users/${uid}/wallet/totalEarnings`
          )
          .transaction(
            value =>
              Number(value || 0) +
              reward
          );

      }

      await tournamentRef.update({

        results,

        settlementStatus:
          "Completed",

        status:
          "Completed",

        settledAt:
          admin.database
            .ServerValue
            .TIMESTAMP

      });

      res.json({

        success: true,

        message:
          "Match settled successfully.",

        results

      });

    } catch (err) {

      console.error(
        "Settlement:",
        err
      );

      res.status(500).json({

        success: false,

        message:
          "Settlement failed."

      });

    }

  }
);

/* =====================================================
   BANNERS
===================================================== */

app.get(
  "/api/banners",
  async (req, res) => {

    res.json(
      await Banner.find().lean()
    );

  }
);

app.post(
  "/api/admin/banners",
  requireAdmin,
  requirePermission,
  async (req, res) => {

    res.json({

      success: true,

      banner:
        await Banner.create(
          req.body
        )

    });

  }
);

app.delete(
  "/api/admin/banners/:id",
  requireAdmin,
  requirePermission,
  async (req, res) => {

    await Banner.findByIdAndDelete(
      req.params.id
    );

    res.json({
      success: true
    });

  }
);


/* =====================================================
   TUTORIALS
===================================================== */

app.get(
  "/api/tutorials",
  async (req, res) => {

    res.json(
      await Tutorial.find().lean()
    );

  }
);

app.post(
  "/api/admin/tutorials",
  requireAdmin,
  requirePermission,
  async (req, res) => {

    res.json({

      success: true,

      tutorial:
        await Tutorial.create(
          req.body
        )

    });

  }
);

app.delete(
  "/api/admin/tutorials/:id",
  requireAdmin,
  requirePermission,
  async (req, res) => {

    await Tutorial.findByIdAndDelete(
      req.params.id
    );

    res.json({
      success: true
    });

  }
);


/* =====================================================
   SYSTEM MODE
===================================================== */

app.get(
  "/api/config/mode",
  async (req, res) => {

    let config =
      await Config.findOne();

    if (!config) {

      config =
        await Config.create({
          appMode: "Live"
        });

    }

    res.json(config);

  }
);


app.post(
  "/api/admin/config/mode",
  requireAdmin,
  requirePermission,
  async (req, res) => {

    const config =
      await Config.findOneAndUpdate(
        {},

        {
          $set: {
            appMode:
              req.body.appMode
          }
        },

        {
          upsert: true,
          new: true
        }
      );

    res.json({

      success: true,

      config

    });

  }
);


/* =====================================================
   COMPATIBILITY
===================================================== */

app.get(
  "/api/notifications",
  requireAuth,
  async (req, res) => {

    const notifications =
      await Notification.find({

        $or: [

          {
            targetUser:
              "ALL"
          },

          {
            targetUser:
              req.firebaseUser.uid
          }

        ]

      })
      .sort({
        sentAt: -1
      })
      .limit(50)
      .lean();

    res.json({

      success: true,

      notifications

    });

  }
);

app.get(
  "/api/coupons",
  requireAdmin,
  requirePermission,
  async (req, res) => {

    res.json(
      await Coupon.find()
        .sort({
          createdAt: -1
        })
        .lean()
    );

  }
);


/* =====================================================
   START
===================================================== */

const PORT =
  process.env.PORT || 5000;

app.listen(
  PORT,
  () =>
    console.log(
      `FFX API running on ${PORT}`
    )
);
 